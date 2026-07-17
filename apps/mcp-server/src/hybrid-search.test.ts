import { describe, expect, mock, test } from "bun:test";
import type { SearchFilters, SearchResult, VectorClient } from "@mf-rag/vector";

import { searchHybridDocuments } from "./hybrid-search.ts";

function pdfResult(): SearchResult {
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
