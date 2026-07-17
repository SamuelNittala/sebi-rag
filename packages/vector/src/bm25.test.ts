import { describe, expect, test } from "bun:test";

import { calculateBm25TermScore, tokenizeBm25Query } from "./bm25.ts";

describe("BM25 query tokenization", () => {
  test("keeps exact finance and proper-name terms while removing stop words", () => {
    expect(tokenizeBm25Query("Who is the fund manager for Platinum SIF, Gaurik Shah?")).toEqual([
      "fund", "manager", "platinum", "sif", "gaurik", "shah",
    ]);
  });

  test("deduplicates repeated terms", () => {
    expect(tokenizeBm25Query("exit load and exit load")).toEqual(["exit", "load"]);
  });

  test("returns no lexical tokens for a stop-word-only query", () => {
    expect(tokenizeBm25Query("what is the for")).toEqual([]);
  });
});

describe("BM25 term scoring", () => {
  test("rewards repeated query evidence with saturation", () => {
    const once = calculateBm25TermScore({
      termFrequency: 1,
      documentLength: 100,
      averageDocumentLength: 100,
      documentCount: 1000,
      documentFrequency: 10,
    });
    const threeTimes = calculateBm25TermScore({
      termFrequency: 3,
      documentLength: 100,
      averageDocumentLength: 100,
      documentCount: 1000,
      documentFrequency: 10,
    });

    expect(threeTimes).toBeGreaterThan(once);
    expect(threeTimes).toBeLessThan(once * 3);
  });

  test("rewards rarer terms more than common terms", () => {
    const rare = calculateBm25TermScore({
      termFrequency: 1,
      documentLength: 100,
      averageDocumentLength: 100,
      documentCount: 1000,
      documentFrequency: 5,
    });
    const common = calculateBm25TermScore({
      termFrequency: 1,
      documentLength: 100,
      averageDocumentLength: 100,
      documentCount: 1000,
      documentFrequency: 500,
    });

    expect(rare).toBeGreaterThan(common);
  });
});
