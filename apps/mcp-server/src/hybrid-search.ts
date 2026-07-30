import type {
  TenantAccessScope,
  HtmlSearchFilters,
  HtmlSearchResult,
  SearchFilters,
  SearchResult,
  VectorClient,
} from "@mf-rag/vector";

import type {
  FusedRetrievalCandidate,
  HybridRetrievalCandidate,
  RetrievalTrace,
} from "./hybrid-retrieval-contracts.ts";
import { fuseHybridCandidates, resolveRetrievalIntent } from "./hybrid-retrieval.ts";
import { retrievalCandidateLimit, type RetrievalRankingProfile } from "./retrieval-ranking.ts";
import type { Reranker } from "./reranker.ts";

export interface MergedResult extends HybridRetrievalCandidate {
  score: number;
  source_type: "scheme_document" | "knowledge_base";
  text: string;
  sectionHeader: string | null;
  retrievalTrace?: RetrievalTrace;
  fundName?: string;
  docType?: string;
  pageNumbers?: number[];
  documentFilename?: string;
  sebiUrl?: string;
  documentTitle?: string;
  contentCategory?: string;
  sourceUrl?: string;
}

export interface HybridSearchOptions {
  accessScope: TenantAccessScope;
  limit: number;
  scoreThreshold: number;
  candidateLimit?: number;
  rrfK?: number;
  pdfFilters?: SearchFilters;
  htmlFilters?: HtmlSearchFilters;
  searchPdf?: boolean;
  searchHtml?: boolean;
  rankingProfile?: RetrievalRankingProfile;
  allowFundFilterFallback?: boolean;
  reranker?: Reranker | null;
  rerankCandidateLimit?: number;
}

function pdfCandidate(result: SearchResult): MergedResult {
  return {
    id: result.id,
    sourceType: "scheme_document",
    metadata: result.payload.retrieval_metadata ?? null,
    score: result.score,
    source_type: "scheme_document",
    text: result.payload.text,
    sectionHeader: result.payload.section_header,
    fundName: result.payload.fund_name,
    docType: result.payload.doc_type,
    pageNumbers: result.payload.page_numbers,
    documentFilename: result.payload.document_filename,
    sebiUrl: result.payload.sebi_url,
    sourceUrl: result.payload.retrieval_metadata?.sourceUrl ?? undefined,
  };
}

function htmlCandidate(result: HtmlSearchResult): MergedResult {
  return {
    id: result.id,
    sourceType: "knowledge_base",
    metadata: result.payload.retrieval_metadata ?? null,
    score: result.score,
    source_type: "knowledge_base",
    text: result.payload.text,
    sectionHeader: result.payload.section_heading,
    documentTitle: result.payload.document_title,
    contentCategory: result.payload.content_category,
    sourceUrl: result.payload.source_url,
  };
}

function globallyRank(candidates: MergedResult[]) {
  return candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate) => ({ candidate, score: candidate.score }));
}

interface CandidateSearchInput {
  accessScope: TenantAccessScope;
  candidateLimit: number;
  scoreThreshold: number;
  pdfFilters?: SearchFilters;
  htmlFilters?: HtmlSearchFilters;
  searchPdf: boolean;
  searchHtml: boolean;
}

async function retrieveCandidates(
  vectorClient: VectorClient,
  query: string,
  queryVector: number[],
  input: CandidateSearchInput,
) {
  const pdfFilters = input.pdfFilters && Object.keys(input.pdfFilters).length > 0
    ? input.pdfFilters
    : undefined;
  const htmlFilters = input.htmlFilters && Object.keys(input.htmlFilters).length > 0
    ? input.htmlFilters
    : undefined;
  const [pdfDense, htmlDense, pdfLexical, htmlLexical] = await Promise.all([
    input.searchPdf
        ? vectorClient.searchSimilar(queryVector, {
          accessScope: input.accessScope,
          limit: input.candidateLimit,
          filters: pdfFilters,
          scoreThreshold: input.scoreThreshold,
        })
      : Promise.resolve([]),
    input.searchHtml
      ? vectorClient.searchHtmlSimilar(queryVector, {
          accessScope: input.accessScope,
          limit: input.candidateLimit,
          filters: htmlFilters,
          scoreThreshold: input.scoreThreshold,
        })
      : Promise.resolve([]),
    input.searchPdf
      ? vectorClient.searchLexical(query, {
          accessScope: input.accessScope,
          limit: input.candidateLimit,
          filters: pdfFilters,
        })
      : Promise.resolve([]),
    input.searchHtml
      ? vectorClient.searchHtmlLexical(query, {
          accessScope: input.accessScope,
          limit: input.candidateLimit,
          filters: htmlFilters,
        })
      : Promise.resolve([]),
  ]);
  return {
    dense: globallyRank([
      ...pdfDense.map(pdfCandidate),
      ...htmlDense.map(htmlCandidate),
    ]),
    lexical: globallyRank([
      ...pdfLexical.map(pdfCandidate),
      ...htmlLexical.map(htmlCandidate),
    ]),
  };
}

function withoutFundFilter(filters: SearchFilters): SearchFilters {
  const fallback = { ...filters };
  delete fallback.fund_name;
  return fallback;
}

function rerankDocument(candidate: MergedResult): string {
  const section = candidate.sectionHeader?.trim();
  if (!section) return candidate.text;
  return `Section: ${section}\n\n${candidate.text}`;
}

function fallbackReason(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown reranker failure";
}

async function applyReranker(
  reranker: Reranker,
  query: string,
  candidates: Array<FusedRetrievalCandidate<MergedResult>>,
  limit: number,
) {
  const reranked = await reranker.rerank(
    query,
    candidates.map(({ candidate }) => rerankDocument(candidate)),
    candidates.length,
  );
  const expectedResults = candidates.length;
  if (reranked.length < expectedResults) {
    throw new Error(
      `Reranker returned ${reranked.length} of ${expectedResults} expected results`,
    );
  }
  return reranked.map((result, index) => {
    const fused = candidates[result.index];
    if (!fused) throw new Error(`Reranker returned invalid result index ${result.index}`);
    const finalScore = result.score + fused.trace.metadataAdjustment;
    return {
      candidate: fused.candidate,
      trace: {
        ...fused.trace,
        rerankRank: index + 1,
        rerankScore: result.score,
        finalScore,
      },
    };
  }).sort((left, right) => right.trace.finalScore - left.trace.finalScore)
    .slice(0, limit);
}

export async function searchHybridDocuments(
  vectorClient: VectorClient,
  query: string,
  queryVector: number[],
  options: HybridSearchOptions,
) {
  const {
    accessScope,
    limit,
    scoreThreshold,
    candidateLimit: configuredCandidateLimit = 40,
    rrfK = 60,
    pdfFilters,
    htmlFilters,
    searchPdf = true,
    searchHtml = true,
    rankingProfile,
    allowFundFilterFallback = false,
    reranker = null,
    rerankCandidateLimit = 20,
  } = options;
  const candidateLimit = Math.max(
    configuredCandidateLimit,
    retrievalCandidateLimit(limit, rankingProfile),
  );
  let candidates = await retrieveCandidates(vectorClient, query, queryVector, {
    accessScope,
    candidateLimit,
    scoreThreshold,
    pdfFilters,
    htmlFilters,
    searchPdf,
    searchHtml,
  });
  let fundFilterFallbackApplied = false;
  const canRetry = allowFundFilterFallback
    && Boolean(pdfFilters?.fund_name)
    && Boolean(pdfFilters?.source_collection)
    && candidates.dense.length === 0
    && candidates.lexical.length === 0;
  if (canRetry && pdfFilters) {
    candidates = await retrieveCandidates(vectorClient, query, queryVector, {
      accessScope,
      candidateLimit,
      scoreThreshold,
      pdfFilters: withoutFundFilter(pdfFilters),
      htmlFilters,
      searchPdf: true,
      searchHtml: Boolean(htmlFilters?.source_collection),
    });
    fundFilterFallbackApplied = true;
  }
  const intent = resolveRetrievalIntent(query);
  const fusionLimit = reranker
    ? Math.max(limit, Math.min(candidateLimit, rerankCandidateLimit))
    : limit;
  const fused = fuseHybridCandidates({
    dense: candidates.dense,
    lexical: candidates.lexical,
    intent,
    limit: fusionLimit,
    rrfK,
  });
  let ranked = fused.slice(0, limit);
  let reranking = {
    applied: false,
    provider: reranker?.provider ?? null,
    model: reranker?.model ?? null,
    candidates: reranker ? fused.length : 0,
    fallbackReason: null as string | null,
  };
  if (reranker && fused.length > 0) {
    try {
      ranked = await applyReranker(reranker, query, fused, limit);
      reranking = { ...reranking, applied: true };
    } catch (error) {
      reranking = { ...reranking, fallbackReason: fallbackReason(error) };
    }
  }
  const results = ranked.map(({ candidate, trace }) => ({
    ...candidate,
    score: trace.finalScore,
    retrievalTrace: trace,
  }));

  return {
    results,
    retrieval: {
      denseCandidates: candidates.dense.length,
      lexicalCandidates: candidates.lexical.length,
      fusion: "rrf" as const,
      rrfK,
      intent,
      fundFilterFallbackApplied,
      reranking,
    },
  };
}
