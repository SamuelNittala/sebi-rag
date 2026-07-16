import { describe, expect, test } from "bun:test";

import { ChunkInspector } from "./index.ts";
import type { InspectionCandidate, InspectionInput } from "./types.ts";

function candidate(
  chunkIndex: number,
  text: string,
  overrides: Partial<InspectionCandidate> = {},
): InspectionCandidate {
  return {
    id: `candidate-${chunkIndex}`,
    chunkIndex,
    text,
    pageNumbers: [chunkIndex + 1],
    tokenCount: Math.max(1, text.trim().split(/\s+/).length),
    hasTable: false,
    sectionHeader: null,
    metadata: { documentScope: "strategy", documentType: "ISID" },
    ...overrides,
  };
}

function input(candidates: InspectionCandidate[]): InspectionInput {
  return {
    document: { id: "document-1", filename: "example.pdf", pageCount: 20 },
    candidates,
  };
}

describe("ChunkInspector", () => {
  test("inspects every candidate even when no findings exist", () => {
    const candidates = [
      candidate(0, "The investment strategy seeks long-term capital appreciation through a diversified portfolio."),
      candidate(1, "Redemption requests are processed according to the interval rules stated in the document."),
    ];

    const report = new ChunkInspector().inspect(input(candidates));

    expect(report.candidateChunkCount).toBe(2);
    expect(report.inspectedChunkCount).toBe(2);
    expect(report.findings).toEqual([]);
  });

  test("blocks an empty candidate", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "   ", { tokenCount: 0 }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: "candidate-0",
      ruleCode: "EMPTY_CHUNK",
      severity: "critical",
      blocksApproval: true,
    }));
  });

  test("blocks a document with no candidate chunks", () => {
    const report = new ChunkInspector().inspect(input([]));

    expect(report.inspectedChunkCount).toBe(0);
    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: null,
      ruleCode: "NO_CHUNKS",
      blocksApproval: true,
    }));
  });

  test("flags table-like staff text that was not marked as a table", () => {
    const text = `Department\nName Age Designation\nEducational Qualification\nTotal No. of years of experience\nExperience & Background\nETF\nMr. Akshay Udeshi\n30 years\nETF Product & Fund Manager\nMBA Finance\n6 years`;
    const report = new ChunkInspector().inspect(input([candidate(0, text)]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "TABLE_LIKE_TEXT_NOT_MARKED_TABLE",
      severity: "critical",
    }));
  });

  test("detects the Akshay staff row split across adjacent chunks", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "ETF Mr. Akshay Udeshi 30 years ETF Product &", { pageNumbers: [28] }),
      candidate(1, "Fund Manager MBA Finance B.E Electronics 6 years Mr. Akshay Udeshi has over 6 years of experience.", {
        pageNumbers: [28, 29],
        sectionHeader: "Fund Manager",
      }),
    ]));

    const finding = report.findings.find(
      (item) => item.ruleCode === "CROSS_CHUNK_ROW_CONTINUATION",
    );
    expect(finding).toBeDefined();
    expect(finding?.candidateId).toBe("candidate-1");
    expect(finding?.blocksApproval).toBe(true);
    expect(finding?.evidence).toEqual(expect.objectContaining({
      previousChunkIndex: 0,
      currentChunkIndex: 1,
    }));
  });

  test("warns when a chunk contains only its heading", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Got Questions? We've Got Answers!", {
        tokenCount: 8,
        sectionHeader: "Got Questions? We've Got Answers!",
      }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      ruleCode: "HEADING_ONLY_CHUNK",
      severity: "warning",
      blocksApproval: false,
    }));
  });

  test("blocks missing and out-of-range page references", () => {
    const report = new ChunkInspector().inspect(input([
      candidate(0, "Content without a source page.", { pageNumbers: [] }),
      candidate(1, "Content from an impossible source page.", { pageNumbers: [21] }),
    ]));

    expect(report.findings.map((finding) => finding.ruleCode)).toContain("MISSING_PAGE_REFERENCE");
    expect(report.findings.map((finding) => finding.ruleCode)).toContain("PAGE_OUT_OF_RANGE");
  });

  test("supports zero-based synthetic sections for HTML", () => {
    const report = new ChunkInspector().inspect({
      document: {
        id: "html-1",
        filename: "article.md",
        pageCount: 2,
        pageNumberBase: 0,
      },
      candidates: [candidate(0, "Article preamble with sufficient explanatory content.", {
        pageNumbers: [0],
      })],
    });

    expect(report.findings.map((item) => item.ruleCode)).not.toContain("PAGE_OUT_OF_RANGE");
  });

  test("uses separate token limits for text and tables", () => {
    const inspector = new ChunkInspector({ maxTextTokens: 10, maxTableTokens: 20 });
    const report = inspector.inspect(input([
      candidate(0, "ordinary text", { tokenCount: 11 }),
      candidate(1, "| A | B |", { tokenCount: 15, hasTable: true }),
    ]));

    expect(report.findings).toContainEqual(expect.objectContaining({
      candidateId: "candidate-0",
      ruleCode: "TOKEN_LIMIT_EXCEEDED",
    }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({
      candidateId: "candidate-1",
      ruleCode: "TOKEN_LIMIT_EXCEEDED",
    }));
  });
});
