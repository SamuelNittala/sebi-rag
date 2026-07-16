import { describe, expect, test } from "bun:test";

import { buildContextualEmbeddingText } from "./contextual-input.ts";

describe("buildContextualEmbeddingText", () => {
  test("prefixes Mirae SIF context without modifying source text", () => {
    const sourceText = "The minimum investment threshold is INR 10 lakh.";

    const embeddingText = buildContextualEmbeddingText(sourceText, {
      fund: "Platinum Hybrid Long-Short Fund",
      document: "Key Information Memorandum",
      section: "Minimum Investment Threshold",
      pages: [13, 14],
      contentType: "table row",
    });

    expect(embeddingText).toContain("Fund: Platinum Hybrid Long-Short Fund");
    expect(embeddingText).toContain("Pages: 13–14");
    expect(embeddingText.endsWith(sourceText)).toBe(true);
    expect(sourceText).toBe("The minimum investment threshold is INR 10 lakh.");
  });

  test("omits missing optional context instead of embedding empty labels", () => {
    const embeddingText = buildContextualEmbeddingText("Definition text", {
      document: "What is a Specialized Investment Fund?",
      contentType: "article",
    });

    expect(embeddingText).not.toContain("Fund:");
    expect(embeddingText).not.toContain("Section:");
    expect(embeddingText).toContain("Document: What is a Specialized Investment Fund?");
  });
});
