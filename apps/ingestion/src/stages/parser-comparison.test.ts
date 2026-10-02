import { describe, expect, test } from "bun:test";

import type { InspectionFinding, InspectionReport } from "@mf-rag/core/chunk-inspection";

import {
  compareParserInspections,
  extractNumericTokens,
  parsePageRange,
  renderComparisonMarkdown,
  restrictArtifactToPages,
  type ComparisonSideInput,
} from "./parser-comparison.ts";
import type { DoclingPdfParseArtifact } from "./docling-parse-stage.ts";
import type { NormalizedPdfParseArtifact } from "./parse-pdf-stage.ts";

function finding(ruleCode: string, overrides: Partial<InspectionFinding> = {}): InspectionFinding {
  return {
    candidateId: null,
    chunkIndex: null,
    ruleCode,
    severity: "warning",
    blocksApproval: false,
    message: ruleCode,
    evidence: {},
    ...overrides,
  };
}

function report(findings: InspectionFinding[]): InspectionReport {
  return {
    inspectorVersion: "1.1.0",
    candidateChunkCount: 0,
    inspectedChunkCount: 0,
    findings,
    criticalCount: findings.filter((item) => item.severity === "critical").length,
    warningCount: findings.filter((item) => item.severity === "warning").length,
    blockingCount: findings.filter((item) => item.blocksApproval).length,
  };
}

function side(
  chunks: { text: string; pageNumbers: number[]; hasTable?: boolean; chunkType?: string; tokenCount?: number }[],
  findings: InspectionFinding[] = [],
  extra: Partial<ComparisonSideInput> = {},
): ComparisonSideInput {
  return {
    candidates: chunks.map((chunk) => ({
      text: chunk.text,
      pageNumbers: chunk.pageNumbers,
      tokenCount: chunk.tokenCount ?? 10,
      hasTable: chunk.hasTable ?? false,
      metadata: chunk.chunkType ? { chunkType: chunk.chunkType } : {},
    })),
    report: report(findings),
    ...extra,
  };
}

describe("extractNumericTokens", () => {
  test("extracts percentages, rupee amounts, plain decimals and dates in canonical form", () => {
    expect(extractNumericTokens(
      "Expense 16.61 % and ₹ 4,506.259 Cr. NAV 23.456 as on 24th February 2023; 31/08/2026 and 30-Sep-2026",
    )).toEqual(["16.61%", "₹4,506.259", "23.456", "24 feb 2023", "31/08/2026", "30 sep 2026"]);
  });

  test("ignores plain integers and does not double-count a percentage as a decimal", () => {
    expect(extractNumericTokens("Holdings 45 stocks, 3.44% weight, Rs. 5,000 minimum")).toEqual(["3.44%", "₹5,000"]);
  });

  test("keeps an attached minus sign and joins split ordinals", () => {
    expect(extractNumericTokens("Return -3.2% since 1 st April 2024")).toEqual(["-3.2%", "1 apr 2024"]);
  });
});

describe("compareParserInspections", () => {
  test("reports findings per rule code with deltas, sorted by rule code", () => {
    const comparison = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side([{ text: "x", pageNumbers: [1] }], [
        finding("TOKEN_LIMIT"),
        finding("TOKEN_LIMIT"),
        finding("BROKEN_TABLE", { severity: "critical", blocksApproval: true }),
      ]),
      docling: side([{ text: "x", pageNumbers: [1], chunkType: "text" }], [
        finding("TOKEN_LIMIT"),
        finding("LOW_STRUCTURE_PAGE"),
      ]),
    });
    expect(comparison.findings.byRule).toEqual([
      { ruleCode: "BROKEN_TABLE", severity: "critical", unpdf: 1, docling: 0, delta: -1 },
      { ruleCode: "LOW_STRUCTURE_PAGE", severity: "warning", unpdf: 0, docling: 1, delta: 1 },
      { ruleCode: "TOKEN_LIMIT", severity: "warning", unpdf: 2, docling: 1, delta: -1 },
    ]);
    expect(comparison.findings.totals).toEqual({
      unpdf: { findings: 3, critical: 1, warning: 2, blocking: 1 },
      docling: { findings: 2, critical: 0, warning: 2, blocking: 0 },
    });
  });

  test("counts chunks by type: Docling chunkType, unpdf table/text from hasTable", () => {
    const comparison = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side([
        { text: "a", pageNumbers: [1], tokenCount: 5 },
        { text: "b", pageNumbers: [1], hasTable: true, tokenCount: 7 },
      ]),
      docling: side([
        { text: "a", pageNumbers: [1], chunkType: "text" },
        { text: "b", pageNumbers: [1], chunkType: "table", hasTable: true },
        { text: "c", pageNumbers: [2], chunkType: "picture" },
        { text: "d", pageNumbers: [2], chunkType: "table", hasTable: true },
      ]),
    });
    expect(comparison.chunks.unpdf).toEqual({ total: 2, tokens: 12, byType: { table: 1, text: 1 } });
    expect(comparison.chunks.docling).toEqual({ total: 4, tokens: 40, byType: { picture: 1, table: 2, text: 1 } });
    expect(Object.keys(comparison.chunks.docling.byType)).toEqual(["picture", "table", "text"]);
  });

  test("lists numeric tokens missing from each side per page, both directions", () => {
    const comparison = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side([
        { text: "AUM ₹4,506.259 Cr, beta 0.95, 12.5%", pageNumbers: [1] },
        { text: "TER 1.62%", pageNumbers: [2] },
      ]),
      docling: side([
        { text: "AUM ₹ 4,506.259 Cr, 12.5 %", pageNumbers: [1] },
        { text: "TER 1.62% allotted 24th February 2023", pageNumbers: [2] },
        { text: "Sharpe 1.07", pageNumbers: [3] },
      ]),
    });
    expect(comparison.numericTokens.pages).toEqual([
      { pageNumber: 1, unpdfCount: 3, doclingCount: 2, missingFromDocling: ["0.95"], missingFromUnpdf: [] },
      { pageNumber: 2, unpdfCount: 1, doclingCount: 2, missingFromDocling: [], missingFromUnpdf: ["24 feb 2023"] },
      { pageNumber: 3, unpdfCount: 0, doclingCount: 1, missingFromDocling: [], missingFromUnpdf: ["1.07"] },
    ]);
    expect(comparison.numericTokens.totals).toEqual({
      unpdf: 4,
      docling: 5,
      missingFromDocling: 1,
      missingFromUnpdf: 2,
    });
  });

  test("attributes a multi-page chunk's tokens to every page it covers", () => {
    const comparison = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side([{ text: "1.5%", pageNumbers: [1] }, { text: "2.5%", pageNumbers: [2] }]),
      docling: side([{ text: "1.5% 2.5%", pageNumbers: [1, 2] }]),
    });
    expect(comparison.numericTokens.pages.map((page) => page.missingFromDocling)).toEqual([[], []]);
    expect(comparison.numericTokens.pages.map((page) => page.missingFromUnpdf)).toEqual([["2.5%"], ["1.5%"]]);
  });

  test("output ordering is deterministic regardless of input order", () => {
    const chunksA = [
      { text: "9.9% 1.1%", pageNumbers: [2] },
      { text: "5.5%", pageNumbers: [1] },
    ];
    const findingsA = [finding("Z_RULE"), finding("A_RULE")];
    const first = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side(chunksA, findingsA),
      docling: side([], []),
    });
    const second = compareParserInspections({
      filename: "a.pdf",
      pageRange: null,
      unpdf: side([...chunksA].reverse(), [...findingsA].reverse()),
      docling: side([], []),
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.numericTokens.pages[1]?.missingFromDocling).toEqual(["1.1%", "9.9%"]);
  });

  test("carries Docling parser diagnostics when present", () => {
    const comparison = compareParserInspections({
      filename: "a.pdf",
      pageRange: { first: 2, last: 3 },
      unpdf: side([]),
      docling: side([], [], { parserDiagnostics: { lowStructurePages: [3], uncoveredPages: [] } }),
    });
    expect(comparison.pageRange).toEqual({ first: 2, last: 3 });
    expect(comparison.doclingDiagnostics).toEqual({ lowStructurePages: [3], uncoveredPages: [] });
  });
});

describe("unpdf table extraction status", () => {
  test("is carried into the comparison and flagged in markdown when it failed", () => {
    const comparison = compareParserInspections({
      filename: "fund.pdf",
      pageRange: null,
      unpdf: side([], [], { tableExtractionStatus: "failed" }),
      docling: side([]),
    });
    expect(comparison.unpdfTableExtraction).toBe("failed");
    expect(renderComparisonMarkdown([comparison], { parserVersions: { unpdf: "u", docling: "d" } }))
      .toContain("unpdf table extraction failed");
  });

  test("is null when not reported", () => {
    const comparison = compareParserInspections({ filename: "a.pdf", pageRange: null, unpdf: side([]), docling: side([]) });
    expect(comparison.unpdfTableExtraction).toBeNull();
  });
});

describe("renderComparisonMarkdown", () => {
  test("renders a summary table, per-rule deltas and per-page token gaps", () => {
    const comparison = compareParserInspections({
      filename: "fund.pdf",
      pageRange: null,
      unpdf: side([{ text: "beta 0.95", pageNumbers: [1] }], [finding("TOKEN_LIMIT")]),
      docling: side([{ text: "beta", pageNumbers: [1], chunkType: "text" }], []),
    });
    const markdown = renderComparisonMarkdown([comparison], { parserVersions: { unpdf: "u1", docling: "d1" } });
    expect(markdown).toContain("# Parser comparison");
    expect(markdown).toContain("| fund.pdf | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |");
    expect(markdown).toContain("| TOKEN_LIMIT | warning | 1 | 0 | -1 |");
    expect(markdown).toContain("| 1 | 0.95 |  |");
    expect(markdown).toContain("Docling: `d1`");
  });
});

describe("parsePageRange", () => {
  test("accepts a single page or an inclusive range", () => {
    expect(parsePageRange("34-35")).toEqual({ first: 34, last: 35 });
    expect(parsePageRange("7")).toEqual({ first: 7, last: 7 });
  });

  test("rejects malformed or inverted ranges", () => {
    for (const value of ["", "0", "5-3", "a-b", "1-2-3", "1,3"]) {
      expect(() => parsePageRange(value)).toThrow();
    }
  });
});

describe("restrictArtifactToPages", () => {
  const unpdf = {
    parser: { parserVersion: "u1", tableExtractorVersion: "t1" },
    pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, text: `p${pageNumber}`, hasTable: pageNumber === 2 })),
    tables: [
      { pageNumber: 2, tableIndex: 0, rows: [], markdown: "t2" },
      { pageNumber: 3, tableIndex: 0, rows: [], markdown: "t3" },
    ],
    diagnostics: { pageCount: 3 },
  } as unknown as NormalizedPdfParseArtifact;

  test("keeps only in-range unpdf pages and tables, original page numbers and page count", () => {
    const restricted = restrictArtifactToPages(unpdf, { first: 2, last: 2 }) as NormalizedPdfParseArtifact;
    expect(restricted.pages.map((page) => page.pageNumber)).toEqual([2]);
    expect(restricted.tables.map((table) => table.markdown)).toEqual(["t2"]);
    expect(restricted.diagnostics.pageCount).toBe(3);
  });

  test("keeps only Docling chunks wholly inside the range", () => {
    const docling = {
      parser: { kind: "docling" },
      pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, text: "", hasTable: false, stats: {} })),
      chunks: [
        { chunkIndex: 0, pages: [1] },
        { chunkIndex: 1, pages: [1, 2] },
        { chunkIndex: 2, pages: [2, 3] },
        { chunkIndex: 3, pages: [3] },
      ],
      diagnostics: { pageCount: 3 },
    } as unknown as DoclingPdfParseArtifact;
    const restricted = restrictArtifactToPages(docling, { first: 2, last: 3 }) as DoclingPdfParseArtifact;
    expect(restricted.pages.map((page) => page.pageNumber)).toEqual([2, 3]);
    expect(restricted.chunks.map((chunk) => chunk.chunkIndex)).toEqual([2, 3]);
  });

  test("rejects a range beyond the document", () => {
    expect(() => restrictArtifactToPages(unpdf, { first: 3, last: 4 })).toThrow();
  });
});
