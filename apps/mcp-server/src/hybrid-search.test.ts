import { describe, expect, mock, test } from "bun:test";
import type { SearchFilters, SearchResult, VectorClient } from "@mf-rag/vector";

import { searchHybridDocuments } from "./hybrid-search.ts";
import type { Reranker } from "./reranker.ts";

function pdfResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chunk-1",
    score: 0.8,
    payload: {
      text: "Platinum Hybrid Long-Short Fund strategy details",
      chunk_index: 1,
      total_chunks: 1,
      document_id: "document-1",
      document_filename: "ISID.pdf",
      page_numbers: [1],
      fund_name: "I Platinum Hybrid Long Short Fund",
      amc_name: "Mirae Asset",
      scheme_type: "Hybrid",
      scheme_category: "Hybrid Long-Short",
      doc_type: "ISID",
      document_date: "2026-05-01",
      has_table: false,
      section_header: "Investment strategy",
      sebi_scheme_id: "",
      sebi_url: "",
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
      amc_slug: "mirae-asset",
      retrieval_metadata: null,
    },
    ...overrides,
  };
}

describe("searchHybridDocuments fund-filter fallback", () => {
  test("retries without the fund filter inside the same collection", async () => {
    const dense = mock(async (_vector: number[], options: { filters?: SearchFilters }) =>
      options.filters?.fund_name ? [] : [pdfResult()]);
    const lexical = mock(async (_query: string, options: { filters?: SearchFilters }) =>
      options.filters?.fund_name ? [] : [pdfResult()]);
    const vectorClient = {
      searchSimilar: dense,
      searchLexical: lexical,
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => []),
    } as unknown as VectorClient;

    const response = await searchHybridDocuments(vectorClient, "tell me about platinum", [0.1], {
      limit: 10,
      scoreThreshold: 0.5,
      pdfFilters: {
        fund_name: "Platinum Hybrid Long-Short Fund",
        knowledge_domain: "sif",
        source_collection: "mirae_sif",
      },
      htmlFilters: { knowledge_domain: "sif", source_collection: "mirae_sif" },
      searchPdf: true,
      searchHtml: false,
      allowFundFilterFallback: true,
    });

    expect(response.results).toHaveLength(1);
    expect(response.retrieval.fundFilterFallbackApplied).toBe(true);
    expect(dense).toHaveBeenCalledTimes(2);
    expect(dense.mock.calls[1]?.[1].filters).toEqual({
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
    });
  });

  test("does not broaden an unreviewed scheme query", async () => {
    const dense = mock(async () => []);
    const vectorClient = {
      searchSimilar: dense,
      searchLexical: mock(async () => []),
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => []),
    } as unknown as VectorClient;

    const response = await searchHybridDocuments(vectorClient, "unknown scheme", [0.1], {
      limit: 10,
      scoreThreshold: 0.5,
      pdfFilters: { fund_name: "Unknown Scheme" },
      searchPdf: true,
      searchHtml: false,
    });

    expect(response.results).toHaveLength(0);
    expect(response.retrieval.fundFilterFallbackApplied).toBe(false);
    expect(dense).toHaveBeenCalledTimes(1);
  });
});

describe("searchHybridDocuments reranking", () => {
  test("promotes the SWP schedule above a broader SIP and SWP chunk", async () => {
    const broadFacilities = pdfResult({
      id: "chunk-8",
      score: 0.91,
      payload: {
        ...pdfResult().payload,
        section_header: "SIP & SWP Special Products/Facilities",
        text: "Systematic Investment Plan dates are 01st to 28th. Systematic Withdrawal Plan enables periodic withdrawals.",
      },
    });
    const swpSchedule = pdfResult({
      id: "chunk-6",
      score: 0.84,
      payload: {
        ...pdfResult().payload,
        section_header: "SWP Withdrawal Details",
        text: "Investors can withdraw on 1st or 10th or 21st of each month, quarter, semi-annual and annual.",
      },
    });
    const rerank = mock(async (_query: string, documents: string[]) => {
      expect(documents[0]).toContain("SIP & SWP Special Products/Facilities");
      expect(documents[1]).toContain("1st or 10th or 21st");
      return [
        { index: 1, score: 0.98 },
        { index: 0, score: 0.41 },
      ];
    });
    const reranker = {
      provider: "test",
      model: "cross-encoder",
      rerank,
      checkHealth: mock(async () => true),
    } satisfies Reranker;
    const vectorClient = {
      searchSimilar: mock(async () => [broadFacilities, swpSchedule]),
      searchLexical: mock(async () => [broadFacilities, swpSchedule]),
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => []),
    } as unknown as VectorClient;

    const response = await searchHybridDocuments(
      vectorClient,
      "On which dates can I make an SWP withdrawal?",
      [0.1],
      {
        limit: 1,
        candidateLimit: 10,
        scoreThreshold: 0.5,
        searchPdf: true,
        searchHtml: false,
        reranker,
        rerankCandidateLimit: 10,
      },
    );

    expect(response.results.map((result) => result.id)).toEqual(["chunk-6"]);
    expect(response.results[0]?.retrievalTrace).toMatchObject({
      preRerankRank: 2,
      rerankRank: 1,
      rerankScore: 0.98,
      finalScore: 0.98,
    });
    expect(response.retrieval.reranking).toMatchObject({
      applied: true,
      provider: "test",
      model: "cross-encoder",
      candidates: 2,
    });
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  test("keeps the fused ranking when the reranker is unavailable", async () => {
    const first = pdfResult({ id: "first", score: 0.9 });
    const second = pdfResult({ id: "second", score: 0.8 });
    const reranker = {
      provider: "test",
      model: "unavailable",
      rerank: mock(async () => {
        throw new Error("provider timed out");
      }),
      checkHealth: mock(async () => false),
    } satisfies Reranker;
    const vectorClient = {
      searchSimilar: mock(async () => [first, second]),
      searchLexical: mock(async () => [first, second]),
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => []),
    } as unknown as VectorClient;

    const response = await searchHybridDocuments(vectorClient, "query", [0.1], {
      limit: 1,
      scoreThreshold: 0.5,
      searchPdf: true,
      searchHtml: false,
      reranker,
    });

    expect(response.results[0]?.id).toBe("first");
    expect(response.retrieval.reranking).toMatchObject({
      applied: false,
      fallbackReason: "provider timed out",
    });
  });
});
