import { describe, expect, test } from "bun:test";

import { adjustRetrievalScore, retrievalCandidateLimit } from "./retrieval-ranking.ts";

describe("adjustRetrievalScore", () => {
  test("does not alter normal semantic-search scores", () => {
    expect(adjustRetrievalScore({
      score: 0.61,
      sourceType: "scheme_document",
      text: "Investment objective",
    })).toBe(0.61);
  });

  test("prioritizes the currently available strategy section", () => {
    const score = adjustRetrievalScore({
      score: 0.61,
      sourceType: "scheme_document",
      text: "EXISTING INVESTMENT STRATEGIES OF THE SPECIALIZED INVESTMENT\nFUND?\nPlatinum Hybrid Long-Short Fund is the new investment strategy.",
      sectionHeader: "EXISTING INVESTMENT STRATEGIES OF THE SPECIALIZED INVESTMENT",
      documentFilename: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
    }, "mirae_sif_overview");

    expect(score).toBeGreaterThan(0.7);
  });

  test("prefers product overview, presentation, SAI, and KIM evidence", () => {
    const genericScore = 0.65;
    const candidates = [
      adjustRetrievalScore({
        score: 0.61,
        sourceType: "knowledge_base",
        text: "# Platinum Hybrid Long-Short Fund\nAn interval investment strategy.",
        contentCategory: "product",
      }, "mirae_sif_overview"),
      adjustRetrievalScore({
        score: 0.61,
        sourceType: "scheme_document",
        text: "Platinum SIF marks a strategic evolution.",
        documentFilename: "Platinum-Hybrid-Long-Short-Fund-Presentation.pdf",
      }, "mirae_sif_overview"),
      adjustRetrievalScore({
        score: 0.61,
        sourceType: "scheme_document",
        text: "Statement of Additional Information for Platinum SIF.",
        documentFilename: "SAI-SIF_March-2026.pdf",
      }, "mirae_sif_overview"),
      adjustRetrievalScore({
        score: 0.61,
        sourceType: "scheme_document",
        text: "Key Information Memorandum for the strategy.",
        documentFilename: "KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
        docType: "KIM",
      }, "mirae_sif_overview"),
    ];

    expect(candidates.every((score) => score > genericScore)).toBe(true);
  });

  test("does not boost an unrelated SAI disclosure section", () => {
    const score = adjustRetrievalScore({
      score: 0.61,
      sourceType: "scheme_document",
      text: "Half-yearly unaudited financial results shall be hosted on the website.",
      sectionHeader: "Half Yearly Results",
      documentFilename: "SAI-SIF_March-2026.pdf",
    }, "mirae_sif_overview");

    expect(score).toBe(0.61);
  });

  test("promotes strategy-specific manager assignments for fund-manager questions", () => {
    const score = adjustRetrievalScore({
      score: 0.59,
      sourceType: "scheme_document",
      text: "E. WHO MANAGES THE INVESTMENT STRATEGY? Name Mr. Gaurik Shah",
      sectionHeader: "E. WHO MANAGES THE INVESTMENT STRATEGY?",
      documentFilename: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
    }, "mirae_sif_fund_manager");

    expect(score).toBeGreaterThan(0.7);
  });

  test("fetches a wider candidate pool before manager reranking", () => {
    expect(retrievalCandidateLimit(10, "mirae_sif_fund_manager")).toBe(30);
    expect(retrievalCandidateLimit(10)).toBe(10);
  });
});
