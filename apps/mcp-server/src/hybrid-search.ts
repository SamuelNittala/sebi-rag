import type {
  HtmlSearchFilters,
  HtmlSearchResult,
  SearchFilters,
  SearchResult,
  VectorClient,
} from "@mf-rag/vector";

import type { HybridRetrievalCandidate, RetrievalTrace } from "./hybrid-retrieval-contracts.ts";
import { fuseHybridCandidates, resolveRetrievalIntent } from "./hybrid-retrieval.ts";
import { retrievalCandidateLimit, type RetrievalRankingProfile } from "./retrieval-ranking.ts";

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
  limit: number;
  scoreThreshold: number;
  candidateLimit?: number;
  rrfK?: number;
  pdfFilters?: SearchFilters;
  htmlFilters?: HtmlSearchFilters;
  searchPdf?: boolean;
  searchHtml?: boolean;
  rankingProfile?: RetrievalRankingProfile;
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

function globallyRank(candidates: MergedResult[], limit: number) {
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((candidate) => ({ candidate, score: candidate.score }));
}

export async function searchHybridDocuments(
  vectorClient: VectorClient,
  query: string,
  queryVector: number[],
  options: HybridSearchOptions,
) {
  const {
    limit,
    scoreThreshold,
    candidateLimit: configuredCandidateLimit = 40,
    rrfK = 60,
    pdfFilters,
    htmlFilters,
    searchPdf = true,
    searchHtml = true,
    rankingProfile,
  } = options;
  const candidateLimit = Math.max(
    configuredCandidateLimit,
    retrievalCandidateLimit(limit, rankingProfile),
  );
  const activePdfFilters = pdfFilters && Object.keys(pdfFilters).length > 0
    ? pdfFilters
    : undefined;
  const activeHtmlFilters = htmlFilters && Object.keys(htmlFilters).length > 0
    ? htmlFilters
    : undefined;

  const [pdfDense, htmlDense, pdfLexical, htmlLexical] = await Promise.all([
    searchPdf
      ? vectorClient.searchSimilar(queryVector, {
          limit: candidateLimit,
          filters: activePdfFilters,
          scoreThreshold,
        })
      : Promise.resolve([]),
    searchHtml
      ? vectorClient.searchHtmlSimilar(queryVector, {
          limit: candidateLimit,
          filters: activeHtmlFilters,
          scoreThreshold,
        })
      : Promise.resolve([]),
    searchPdf
      ? vectorClient.searchLexical(query, {
          limit: candidateLimit,
          filters: activePdfFilters,
        })
      : Promise.resolve([]),
    searchHtml
      ? vectorClient.searchHtmlLexical(query, {
          limit: candidateLimit,
          filters: activeHtmlFilters,
        })
      : Promise.resolve([]),
  ]);
  const dense = globallyRank([
    ...pdfDense.map(pdfCandidate),
    ...htmlDense.map(htmlCandidate),
  ], candidateLimit);
  const lexical = globallyRank([
    ...pdfLexical.map(pdfCandidate),
    ...htmlLexical.map(htmlCandidate),
  ], candidateLimit);
  const intent = resolveRetrievalIntent(query);
  const fused = fuseHybridCandidates({ dense, lexical, intent, limit, rrfK });
  const results = fused.map(({ candidate, trace }) => ({
    ...candidate,
    score: trace.finalScore,
    retrievalTrace: trace,
  }));

  return {
    results,
    retrieval: {
      denseCandidates: dense.length,
      lexicalCandidates: lexical.length,
      fusion: "rrf" as const,
      rrfK,
      intent,
    },
  };
}
