import { describe, expect, test } from "bun:test";
import {
  buildGenericDocumentCitations,
  buildSchemeDocumentCitations,
} from "./citations.ts";
import type { MergedResult } from "./hybrid-search.ts";

function result(overrides: Partial<MergedResult>): MergedResult {
  return {
    id: "chunk",
    sourceType: "scheme_document",
    source_type: "scheme_document",
    metadata: null,
    score: 0.9,
    text: "text",
    sectionHeader: null,
    ...overrides,
  };
}

describe("PDF citation variants", () => {
  test("preserves the existing scheme citation shape", () => {
    expect(buildSchemeDocumentCitations([result({
      fundName: "Alpha Fund",
      docType: "SID",
      pageNumbers: [3],
      sebiUrl: "https://sebi.example/scheme",
    })])).toEqual([{
      fundName: "Alpha Fund",
      docType: "SID",
      amendmentNumber: "",
      pageNumbers: [3],
      sebiUrl: "https://sebi.example/scheme",
      sourceUrl: "",
    }]);
  });

  test("returns generic FAQ identity and merges continuation pages", () => {
    const common = {
      sourceType: "generic_document" as const,
      source_type: "generic_document" as const,
      documentTitle: "FAQs for Mutual Fund Investors",
      publisher: "Securities and Exchange Board of India",
      sourceUrl: "https://sebi.example/faq.pdf",
      sourceDate: "2024-09-25",
      authority: "regulator",
      question: "How do I complete KYC?",
      topic: "KYC",
    };
    expect(buildGenericDocumentCitations([
      result({ ...common, pageNumbers: [4] }),
      result({ ...common, id: "continuation", pageNumbers: [5] }),
    ])).toEqual([{
      title: "FAQs for Mutual Fund Investors",
      publisher: "Securities and Exchange Board of India",
      sourceUrl: "https://sebi.example/faq.pdf",
      sourceDate: "2024-09-25",
      authority: "regulator",
      pageNumbers: [4, 5],
      question: "How do I complete KYC?",
      topic: "KYC",
    }]);
  });
});
