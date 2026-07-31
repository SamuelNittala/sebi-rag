import { describe, expect, test } from "bun:test";

import { buildRawSearchResults } from "./search-results.ts";
import type { MergedResult } from "./hybrid-search.ts";

describe("buildRawSearchResults", () => {
  test("preserves generic-document authority and question number", () => {
    const result = {
      id: "faq-7",
      score: 0.9,
      sourceType: "generic_document",
      source_type: "generic_document",
      metadata: null,
      text: "A SIP invests periodically.",
      sectionHeader: null,
      documentTitle: "MF FAQ",
      publisher: "SEBI",
      sourceUrl: "https://sebi.example/faq.pdf",
      sourceDate: "2024-09-25",
      authority: "regulator",
      pageNumbers: [4],
      question: "What is SIP?",
      questionNumber: "7",
      topic: "SIP",
    } satisfies MergedResult;

    expect(buildRawSearchResults([result])).toMatchObject([{
      source_type: "generic_document",
      authority: "regulator",
      questionNumber: "7",
    }]);
  });
});
