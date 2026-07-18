import { describe, expect, test } from "bun:test";

import { classifyDocumentScope } from "./review-metadata.ts";
import { prepareChunkReview } from "./review-preparation.ts";

describe("prepareChunkReview", () => {
  test("creates deterministic candidates and inspects every chunk", () => {
    const input = {
      document: { id: "document-1", filename: "example.pdf", pageCount: 2 },
      chunks: [
        {
          text: "Investment objective and strategy details for the fund.",
          chunkIndex: 0,
          pageNumbers: [1],
          hasTable: false,
          sectionHeader: "Investment objective",
          tokenCount: 8,
        },
      ],
      metadata: {
        documentScope: "strategy" as const,
        documentType: "ISID",
        fundName: "Platinum Hybrid Long-Short Fund",
      },
    };

    const first = prepareChunkReview(input);
    const second = prepareChunkReview(input);

    expect(first.candidates).toHaveLength(1);
    expect(first.report.inspectedChunkCount).toBe(1);
    expect(first.candidates[0]?.id).toBe(second.candidates[0]?.id);
    expect(first.candidates[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("prepares FAQ and Four Pager documents under strategy scope", () => {
    for (const filename of [
      "Mirae-SIF-Platinum-FAQ.pdf",
      "Platinum-Hybrid-Long-Short-Fund-Four-Pager-1.pdf",
    ]) {
      const documentScope = classifyDocumentScope({
        filename,
        documentType: "Unknown",
        sourceCollection: "mirae_sif",
        fundName: null,
      });
      expect(documentScope).toBe("strategy");

      const prepared = prepareChunkReview({
        document: { id: "doc-faq", filename, pageCount: 4 },
        chunks: [
          {
            text: "The strategy is managed by the designated fund manager.",
            chunkIndex: 0,
            pageNumbers: [1],
            hasTable: false,
            sectionHeader: "E. WHO MANAGES THE INVESTMENT STRATEGY?",
            tokenCount: 10,
          },
        ],
        metadata: { documentScope, documentType: "Unknown" },
      });

      expect(prepared.candidates[0]?.metadata).toEqual(expect.objectContaining({
        sectionType: "strategy_management",
        factType: "fund_manager",
      }));
    }
  });

  test("surfaces adjacent context in the known personnel-row failure", () => {
    const prepared = prepareChunkReview({
      document: { id: "sai-document", filename: "SAI-SIF_March-2026.pdf", pageCount: 138 },
      chunks: [
        {
          text: "ETF Mr. Akshay Udeshi 30 years ETF Product &",
          chunkIndex: 81,
          pageNumbers: [28],
          hasTable: false,
          sectionHeader: null,
          tokenCount: 10,
        },
        {
          text: "Fund Manager MBA Finance B.E Electronics 6 years Mr. Akshay Udeshi has over 6 years of experience.",
          chunkIndex: 82,
          pageNumbers: [28, 29],
          hasTable: false,
          sectionHeader: "Fund Manager",
          tokenCount: 18,
        },
      ],
      metadata: { documentScope: "amc", documentType: "SAI" },
    });

    expect(prepared.report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "CROSS_CHUNK_ROW_CONTINUATION",
      candidateId: prepared.candidates[1]?.id,
    }));
    expect(prepared.candidates[1]?.metadata).toEqual(expect.objectContaining({
      sectionType: "staff_directory",
      factType: null,
    }));
  });
});
