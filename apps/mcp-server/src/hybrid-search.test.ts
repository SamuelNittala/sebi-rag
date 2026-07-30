import { describe, expect, mock, test } from "bun:test";
import type {
  HtmlSearchResult,
  SearchFilters,
  SearchResult,
  TenantAccessScope,
  VectorClient,
} from "@mf-rag/vector";

import { searchHybridDocuments } from "./hybrid-search.ts";
import type { Reranker } from "./reranker.ts";

const accessScope = Object.freeze({
  tenantId: "tenant-a",
}) as TenantAccessScope;

function pdfResult(
  id = "chunk-1",
  score = 0.8,
  retrievalMetadata: SearchResult["payload"]["retrieval_metadata"] = null,
): SearchResult {
  return {
    id,
    score,
    payload: {
      text: `Platinum Hybrid Long-Short Fund strategy details ${id}`,
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
      retrieval_metadata: retrievalMetadata,
    },
  };
}

function htmlResult(
  id: string,
  score: number,
  overrides: Partial<HtmlSearchResult> = {},
): HtmlSearchResult {
  return {
    id,
    score,
    payload: {
      text: `Platinum SIF knowledge article ${id}`,
      chunk_index: 1,
      total_chunks: 1,
      document_id: "html-document-1",
      document_title: "Platinum SIF",
      source_url: `https://example.com/${id}`,
      content_category: "product",
      section_heading: "Overview",
      has_table: false,
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
      amc_slug: "mirae-asset",
      retrieval_metadata: null,
    },
    ...overrides,
  };
}

describe("searchHybridDocuments fund-filter fallback", () => {
  test("passes the immutable access scope to every retrieval branch and fallback", async () => {
    const calls: Array<{ method: string; tenantId: string }> = [];
    const recordScope = (method: string) =>
      mock(async (_query: unknown, options: { accessScope: { tenantId: string } }) => {
        calls.push({ method, tenantId: options.accessScope.tenantId });
        return [];
      });
    const vectorClient = {
      searchSimilar: recordScope("pdf-dense"),
      searchLexical: recordScope("pdf-lexical"),
      searchHtmlSimilar: recordScope("html-dense"),
      searchHtmlLexical: recordScope("html-lexical"),
    } as unknown as VectorClient;

    await searchHybridDocuments(vectorClient, "unknown scheme", [0.1], {
      accessScope,
      limit: 10,
      scoreThreshold: 0.5,
      pdfFilters: {
        fund_name: "Unknown Scheme",
        source_collection: "mirae_sif",
      },
      htmlFilters: { source_collection: "mirae_sif" },
      searchPdf: true,
      searchHtml: true,
      allowFundFilterFallback: true,
    });

    expect(calls).toEqual([
      { method: "pdf-dense", tenantId: "tenant-a" },
      { method: "html-dense", tenantId: "tenant-a" },
      { method: "pdf-lexical", tenantId: "tenant-a" },
      { method: "html-lexical", tenantId: "tenant-a" },
      { method: "pdf-dense", tenantId: "tenant-a" },
      { method: "html-dense", tenantId: "tenant-a" },
      { method: "pdf-lexical", tenantId: "tenant-a" },
      { method: "html-lexical", tenantId: "tenant-a" },
    ]);
  });

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
      accessScope,
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
      accessScope,
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

describe("searchHybridDocuments candidate fusion", () => {
  test("keeps per-source candidates until reviewed metadata reranking", async () => {
    const minimumInvestment = pdfResult("minimum-investment", 6, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "minimum_investment",
      factType: "minimum_investment",
      sourceAuthority: "regulatory_filing",
      classificationSource: "body_evidence",
      confidence: 0.7,
    });
    const higherPdfResults = [
      minimumInvestment,
      ...Array.from(
        { length: 32 },
        (_, index) => pdfResult(`pdf-${index}`, 6 - index * 0.01),
      ),
    ];
    const lowerPdfResults = Array.from(
      { length: 6 },
      (_, index) => pdfResult(`pdf-lower-${index}`, 4 - index * 0.01),
    );
    const redemption = pdfResult("redemption", 4.67, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "redemption",
      factType: "redemption",
      sourceAuthority: "regulatory_filing",
      classificationSource: "exact_heading",
      confidence: 1,
    });
    const vectorClient = {
      searchSimilar: mock(async () => [minimumInvestment]),
      searchLexical: mock(async () => [
        ...higherPdfResults,
        redemption,
        ...lowerPdfResults,
      ]),
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => Array.from(
        { length: 7 },
        (_, index) => htmlResult(`html-${index}`, 5.5 - index * 0.01),
      )),
    } as unknown as VectorClient;

    const response = await searchHybridDocuments(
      vectorClient,
      "when can I do redemption in platinum sif?",
      [0.1],
      {
        accessScope,
        limit: 10,
        candidateLimit: 40,
        scoreThreshold: 0.5,
        pdfFilters: { knowledge_domain: "sif", source_collection: "mirae_sif" },
        htmlFilters: { knowledge_domain: "sif", source_collection: "mirae_sif" },
      },
    );

    expect(response.results[0]?.id).toBe("redemption");
    expect(response.results[0]?.retrievalTrace?.lexicalRank).toBe(41);
    expect(response.results[0]?.retrievalTrace?.metadataSignals).toContain(
      "classification:exact_heading"
    );
  });

  test("does not reintroduce a superseded provision during reranking", async () => {
    const previous = pdfResult("previous", 0.9, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "minimum_investment",
      factType: "minimum_investment",
      documentType: "ISID",
    });
    const addendum = pdfResult("addendum", 0.8, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "minimum_investment",
      factType: "minimum_investment",
      documentType: "Addendum",
      effectiveDate: "2026-07-01",
      supersessionKey: "minimum_sip_installment",
    });
    previous.payload.text = "The minimum SIP installment is Rs. 50,000.";
    addendum.payload.text = "The current minimum SIP installment is Rs. 5,000.";
    const vectorClient = {
      searchSimilar: mock(async () => [previous, addendum]),
      searchLexical: mock(async () => [previous, addendum]),
      searchHtmlSimilar: mock(async () => []),
      searchHtmlLexical: mock(async () => []),
    } as unknown as VectorClient;
    const reranker: Reranker = {
      provider: "test",
      model: "reverse",
      rerank: mock(async () => [
        { index: 0, score: 0.5 },
      ]),
    };

    const response = await searchHybridDocuments(
      vectorClient,
      "What is the minimum SIP installment for Platinum SIF?",
      [0.1],
      {
        accessScope,
        limit: 2,
        scoreThreshold: 0,
        searchPdf: true,
        searchHtml: false,
        reranker,
      },
    );

    expect(response.results[0]?.id).toBe("addendum");
    expect(response.results.some((item) => item.id === "previous")).toBe(false);
    expect(response.results[0]?.retrievalTrace?.metadataSignals)
      .toContain("temporal:effective_addendum");
  });
});
