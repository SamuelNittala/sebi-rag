import { describe, expect, test } from "bun:test";

import { chunkFaqItems } from "./faq-chunker.ts";

describe("FAQ chunker", () => {
  test("keeps a short question and answer atomic", () => {
    const result = chunkFaqItems({
      source: {
        id: "source-a",
        title: "Official FAQ",
        publisher: "Official Publisher",
        authority: "regulator",
        canonicalUrl: "https://example.test/faq.pdf",
        sourceDate: "2024-09-25",
        sha256: "a".repeat(64),
        parserProfile: "sebi-unnumbered-v1",
      },
      items: [{
        question: "What is NAV?",
        answer: "NAV is the net asset value per unit.",
        questionNumber: null,
        topic: "Mutual Funds",
        pageNumbers: [2],
      }],
      maxTokens: 100,
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.text).toContain("Question: What is NAV?");
    expect(result.chunks[0]!.text).toContain("Answer: NAV is");
    expect(result.chunks[0]!.faq.continuationIndex).toBe(0);
  });

  test("splits a long answer at paragraphs and repeats all retrieval context", () => {
    const result = chunkFaqItems({
      source: {
        id: "source-b",
        title: "NISM FAQ",
        publisher: "NISM",
        authority: "sebi_established_institute",
        canonicalUrl: "https://example.test/nism.pdf",
        sourceDate: "2021-02-01",
        sha256: "b".repeat(64),
        parserProfile: "nism-numbered-v1",
      },
      items: [{
        question: "How does diversification help?",
        answer: [
          "First paragraph contains enough explanatory words to consume a meaningful token budget for this fixture.",
          "Second paragraph explains that different assets may move in different directions during volatile markets.",
          "Third paragraph makes clear that diversification cannot remove every investment risk.",
        ].join("\n\n"),
        questionNumber: "3",
        topic: "Mutual Fund Investing",
        pageNumbers: [4, 5],
      }],
      maxTokens: 48,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    result.chunks.forEach((chunk, index) => {
      expect(chunk.text).toContain("Source: NISM FAQ");
      expect(chunk.text).toContain("Topic: Mutual Fund Investing");
      expect(chunk.text).toContain("Question: How does diversification help?");
      expect(chunk.pageNumbers).toEqual([4, 5]);
      expect(chunk.faq.continuationIndex).toBe(index);
    });
  });
});
