import { describe, expect, test } from "bun:test";

import { prepareManualChunkEdit } from "./manual-edit.ts";
import type { EditableInspectionCandidate } from "./types.ts";

function candidate(
  id: string,
  chunkIndex: number,
  text: string,
  sectionHeader: string | null = null,
): EditableInspectionCandidate {
  return {
    id,
    chunkIndex,
    text,
    pageNumbers: [28],
    tokenCount: Math.round(text.trim().split(/\s+/).length * 1.3),
    hasTable: false,
    sectionHeader,
    metadata: { documentScope: "amc", documentType: "SAI" },
    contentHash: `${id}-hash`,
  };
}

describe("prepareManualChunkEdit", () => {
  test("reinspects all candidates after replacing a boundary fragment", () => {
    const candidates = [
      candidate("previous", 81, "ETF Mr. Akshay Udeshi 30 years ETF Product &"),
      candidate(
        "current",
        82,
        "Fund Manager MBA Finance 6 years Mr. Akshay Udeshi",
        "Fund Manager",
      ),
    ];

    const result = prepareManualChunkEdit({
      document: { id: "document", filename: "SAI-SIF.pdf", pageCount: 100 },
      candidates,
      candidateId: "previous",
      expectedContentHash: "previous-hash",
      text: "ETF product team directory.",
    });

    expect(result.text).toBe("ETF product team directory.");
    expect(result.beforeContentHash).toBe("previous-hash");
    expect(result.afterContentHash).not.toBe(result.beforeContentHash);
    expect(result.tokenCount).toBe(5);
    expect(result.report.inspectedChunkCount).toBe(2);
    expect(result.report.findings.map((finding) => finding.ruleCode))
      .not.toContain("CROSS_CHUNK_ROW_CONTINUATION");
  });

  test("rejects an empty edit", () => {
    expect(() => prepareManualChunkEdit({
      document: { id: "document", filename: "document.pdf", pageCount: 1 },
      candidates: [candidate("candidate", 0, "Original text")],
      candidateId: "candidate",
      expectedContentHash: "candidate-hash",
      text: "   ",
    })).toThrow("Edited chunk text is required.");
  });

  test("rejects stale and unchanged edits", () => {
    const candidates = [candidate("candidate", 0, "Original text")];
    const input = {
      document: { id: "document", filename: "document.pdf", pageCount: 1 },
      candidates,
      candidateId: "candidate",
      expectedContentHash: "stale-hash",
      text: "New text",
    };

    expect(() => prepareManualChunkEdit(input)).toThrow("Chunk changed after this page was loaded.");
    expect(() => prepareManualChunkEdit({
      ...input,
      expectedContentHash: "candidate-hash",
      text: " Original text ",
    })).toThrow("Edited chunk text is unchanged.");
  });

  test("reinspects edited FAQ structure and surfaces newly introduced warnings", () => {
    const result = prepareManualChunkEdit({
      document: { id: "faq-doc", filename: "faq.pdf", pageCount: 3 },
      ownership: { visibilityScope: "GLOBAL", tenantId: null },
      candidates: [{
        id: "faq-candidate",
        chunkIndex: 0,
        text: "Question:\nAnswer:",
        pageNumbers: [1],
        tokenCount: 2,
        hasTable: false,
        sectionHeader: "Tax",
        metadata: {
          documentScope: "regulatory",
          documentKind: "FAQ",
          documentTitle: "Investor FAQ",
          publisher: "Authority",
          sourceUrl: "https://example.test/faq.pdf",
          sourceCollection: "general_mf_faq",
          originalQuestion: "",
          answer: "",
          sourceCoverageComplete: true,
        },
        contentHash: "current-hash",
      }],
      candidateId: "faq-candidate",
      expectedContentHash: "current-hash",
      text: "Question: What is the current tax rate?\nAnswer: The current rate is 10%.",
    });

    expect(result.report.findings.map((finding) => finding.ruleCode)).not.toContain(
      "FAQ_ANSWER_MISSING",
    );
    expect(result.report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "FAQ_TIME_SENSITIVE",
      severity: "warning",
    }));
  });
});
