import { describe, expect, test } from "bun:test";

import { resolveRetrievalScope } from "./retrieval-scope.ts";

describe("resolveRetrievalScope", () => {
  test("routes a generic SIF definition question to regulatory and education SIF knowledge", () => {
    const scope = resolveRetrievalScope({
      question: "What is SIF?",
    });

    expect(scope.searchPdf).toBe(false);
    expect(scope.searchHtml).toBe(true);
    expect(scope.htmlFilters).toEqual({
      knowledge_domain: "sif",
      content_category: ["regulatory", "education"],
    });
  });

  test("generic SIF concept questions include education content but never product pages", () => {
    const scope = resolveRetrievalScope({
      question: "what is the tax on SIF gains",
    });

    expect(scope.searchPdf).toBe(false);
    expect(scope.searchHtml).toBe(true);
    expect(scope.htmlFilters.knowledge_domain).toBe("sif");
    expect(scope.htmlFilters.content_category).toEqual(["regulatory", "education"]);
    expect(scope.htmlFilters.content_category).not.toContain("product");
    expect(scope.htmlFilters.source_collection).toBeUndefined();
  });

  test("routes an explicitly Mirae SIF question to the Mirae collection", () => {
    const scope = resolveRetrievalScope({
      question: "Tell me about Mirae SIF",
      topic: "sif",
      amc_name: "Mirae Asset",
    });

    expect(scope.searchPdf).toBe(true);
    expect(scope.searchHtml).toBe(true);
    expect(scope.pdfFilters).toMatchObject({
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
    });
    expect(scope.htmlFilters).toMatchObject({
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
    });
  });

  test("uses a Mirae mention in the question as a validated demo alias", () => {
    const scope = resolveRetrievalScope({
      question: "What risks does the Mirae specialized investment fund have?",
    });

    expect(scope.htmlFilters.source_collection).toBe("mirae_sif");
    expect(scope.pdfFilters.source_collection).toBe("mirae_sif");
  });

  test("recognizes the Platinum Hybrid demo strategy without an agent filter", () => {
    const scope = resolveRetrievalScope({
      question: "Tell me about Platinum Hybrid Fund",
    });

    expect(scope.searchPdf).toBe(true);
    expect(scope.pdfFilters.source_collection).toBe("mirae_sif");
    expect(scope.htmlFilters.source_collection).toBe("mirae_sif");
  });

  test("resolves a bare Platinum reference from the reviewed strategy manifest", () => {
    const scope = resolveRetrievalScope({ question: "Tell me about platinum" });

    expect(scope.searchPdf).toBe(true);
    expect(scope.searchHtml).toBe(true);
    expect(scope.pdfFilters.source_collection).toBe("mirae_sif");
    expect(scope.htmlFilters.source_collection).toBe("mirae_sif");
  });

  test("resolves a hybrid long-short alias from the reviewed strategy manifest", () => {
    const scope = resolveRetrievalScope({
      question: "How does the hybrid long short strategy work?",
      scheme_name: "hybrid long-short",
    });

    expect(scope.pdfFilters.fund_name).toBe("Platinum Hybrid Long-Short Fund");
    expect(scope.pdfFilters.source_collection).toBe("mirae_sif");
    expect(scope.allowFundFilterFallback).toBe(true);
  });

  test("recognizes plural SIFs and keeps the query in regulatory knowledge", () => {
    const scope = resolveRetrievalScope({
      question: "What are the risk factors associated with investing in SIFs?",
    });

    expect(scope.searchPdf).toBe(false);
    expect(scope.searchHtml).toBe(true);
    expect(scope.htmlFilters.source_collection).toBe("sebi_regulatory");
  });

  test("keeps an explicit scheme query limited to scheme documents", () => {
    const scope = resolveRetrievalScope({
      question: "Tell me about Platinum Hybrid Long-Short Fund",
      scheme_name: "Platinum Hybrid Long-Short Fund",
    });

    expect(scope.searchPdf).toBe(true);
    expect(scope.searchHtml).toBe(false);
    expect(scope.pdfFilters.fund_name).toBe("Platinum Hybrid Long-Short Fund");
    expect(scope.pdfFilters.source_collection).toBe("mirae_sif");
    expect(scope.allowFundFilterFallback).toBe(true);
  });

  test("treats Platinum SIF as an umbrella instead of an exact strategy name", () => {
    const scope = resolveRetrievalScope({
      question: "Which strategy is currently available under Platinum SIF?",
      topic: "sif",
      amc_name: "Mirae Asset",
      scheme_name: "Platinum SIF",
    });

    expect(scope.searchPdf).toBe(true);
    expect(scope.searchHtml).toBe(true);
    expect(scope.rankingProfile).toBe("mirae_sif_overview");
    expect(scope.pdfFilters).toEqual({
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
    });
    expect(scope.htmlFilters).toEqual({
      knowledge_domain: "sif",
      source_collection: "mirae_sif",
    });
  });

  test("uses the overview ranking profile for a Platinum SIF introduction", () => {
    const scope = resolveRetrievalScope({
      question: "Tell me about Platinum SIF",
    });

    expect(scope.rankingProfile).toBe("mirae_sif_overview");
  });

  test("uses strategy-manager ranking for an umbrella fund-manager question", () => {
    const scope = resolveRetrievalScope({
      question: "Who is the fund manager for Platinum SIF?",
    });

    expect(scope.rankingProfile).toBe("mirae_sif_fund_manager");
  });

  test("preserves the existing broad search for an unrelated generic question", () => {
    const scope = resolveRetrievalScope({
      question: "How does SIP investing work?",
    });

    expect(scope.searchPdf).toBe(true);
    expect(scope.searchHtml).toBe(true);
    expect(scope.pdfFilters).toEqual({});
    expect(scope.htmlFilters).toEqual({});
  });

  test("does not allow a fund-filter fallback for an unreviewed scheme", () => {
    const scope = resolveRetrievalScope({
      question: "Tell me about an unrelated fund",
      scheme_name: "Unrelated Fund",
    });

    expect(scope.allowFundFilterFallback).toBe(false);
  });
});
