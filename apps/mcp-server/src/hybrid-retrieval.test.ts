import { describe, expect, test } from "bun:test";

import type { HybridRetrievalCandidate } from "./hybrid-retrieval-contracts.ts";
import {
  fuseHybridCandidates,
  resolveRetrievalIntent,
} from "./hybrid-retrieval.ts";

interface Candidate extends HybridRetrievalCandidate {
  text: string;
}

function candidate(
  id: string,
  text: string,
  metadata: HybridRetrievalCandidate["metadata"] = null,
  sourceType: Candidate["sourceType"] = "scheme_document",
): Candidate {
  return { id, sourceType, text, metadata };
}

describe("hybrid retrieval intent", () => {
  test("identifies strategy-manager intent for Platinum SIF", () => {
    expect(resolveRetrievalIntent("Who is the fund manager for Platinum SIF?")).toEqual({
      factType: "fund_manager",
      strategyId: "platinum-hybrid-long-short-fund",
      preferredDocumentScope: "strategy",
    });
  });

  test("identifies investment-objective intent", () => {
    expect(resolveRetrievalIntent("What is the investment objective for Platinum SIF?")).toMatchObject({
      factType: "investment_objective",
      preferredDocumentScope: "strategy",
    });
  });

  test("keeps a generic SIF definition at umbrella scope", () => {
    expect(resolveRetrievalIntent("What is a Specialized Investment Fund?")).toEqual({
      factType: null,
      strategyId: null,
      preferredDocumentScope: "sif_umbrella",
    });
  });

  test("keeps the plural SIFs form at umbrella scope", () => {
    expect(resolveRetrievalIntent("Explain SIFs").preferredDocumentScope)
      .toBe("sif_umbrella");
  });
});

describe("reciprocal-rank fusion", () => {
  test("prefers evidence found by both retrievers without adding raw scores", () => {
    const shared = candidate("shared", "Investment objective");
    const denseOnly = candidate("dense", "Semantic result");
    const lexicalOnly = candidate("lexical", "Exact words");
    const result = fuseHybridCandidates({
      dense: [
        { candidate: denseOnly, score: 0.99 },
        { candidate: shared, score: 0.61 },
      ],
      lexical: [
        { candidate: lexicalOnly, score: 1000 },
        { candidate: shared, score: 0.01 },
      ],
      intent: resolveRetrievalIntent("ordinary query"),
      limit: 3,
    });

    expect(result[0]?.candidate.id).toBe("shared");
    expect(result.find((item) => item.candidate.id === "lexical")?.trace.denseRank).toBeNull();
    expect(result[0]?.trace).toMatchObject({ denseRank: 2, lexicalRank: 2 });
  });

  test("keeps equal UUIDs from different source families distinct", () => {
    const result = fuseHybridCandidates({
      dense: [{ candidate: candidate("same", "PDF"), score: 0.8 }],
      lexical: [{
        candidate: candidate("same", "HTML", null, "knowledge_base"),
        score: 4,
      }],
      intent: resolveRetrievalIntent("ordinary query"),
      limit: 2,
    });

    expect(result).toHaveLength(2);
  });
});

describe("reviewed metadata ranking", () => {
  test("ranks Gaurik's strategy assignment above an SAI staff directory", () => {
    const gaurik = candidate("gaurik", "Mr. Gaurik Shah", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "strategy_management",
      factType: "fund_manager",
      sourceAuthority: "regulatory_filing",
      classificationSource: "exact_heading",
      confidence: 1,
    });
    const staff = candidate("staff", "Mr. Akshay Udeshi", {
      documentScope: "sif_umbrella",
      strategyId: null,
      sectionType: "staff_directory",
      factType: null,
      sourceAuthority: "regulatory_filing",
    });
    const result = fuseHybridCandidates({
      dense: [
        { candidate: staff, score: 0.8 },
        { candidate: gaurik, score: 0.7 },
      ],
      lexical: [],
      intent: resolveRetrievalIntent("Who is the fund manager for Platinum SIF?"),
      limit: 2,
    });

    expect(result[0]?.candidate.id).toBe("gaurik");
    expect(result[0]?.trace.metadataSignals).toContain("fact_type:fund_manager");
    expect(result[0]?.trace.metadataSignals).toContain("classification:exact_heading");
    expect(result[0]?.trace.finalScore).toBeGreaterThan(1);
    expect(result[1]?.trace.metadataSignals).toContain("penalty:staff_directory");
  });

  test("promotes reviewed investment-objective evidence into the top three", () => {
    const dense = Array.from({ length: 10 }, (_, index) => ({
      candidate: candidate(`generic-${index}`, `Generic result ${index}`, {
        documentScope: "strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        sectionType: "overview",
        factType: null,
      }),
      score: 0.9 - index * 0.01,
    }));
    const objective = candidate("objective", "The investment objective is...", {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "investment_objective",
      factType: "investment_objective",
      sourceAuthority: "regulatory_filing",
      classificationSource: "exact_heading",
      confidence: 1,
    });
    dense.push({ candidate: objective, score: 0.79 });

    const result = fuseHybridCandidates({
      dense,
      lexical: [{ candidate: objective, score: 8 }],
      intent: resolveRetrievalIntent("What is the investment objective for Platinum SIF?"),
      limit: 10,
    });

    expect(result.findIndex((item) => item.candidate.id === "objective")).toBeLessThan(3);
  });

  test("keeps candidates with missing metadata and records no adjustment", () => {
    const result = fuseHybridCandidates({
      dense: [{ candidate: candidate("plain", "Fallback"), score: 0.7 }],
      lexical: [],
      intent: resolveRetrievalIntent("What is the exit load?"),
      limit: 1,
    });

    expect(result[0]?.candidate.id).toBe("plain");
    expect(result[0]?.trace.metadataAdjustment).toBe(0);
  });
});
