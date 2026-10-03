import { beforeAll, describe, expect, test } from "bun:test";

import { mapDoclingChunks } from "../../../../ingestion/src/chunkers/docling-chunk-mapper.ts";
import type { DoclingParseResponse, DoclingWireChunk } from "../../../../ingestion/src/parsers/docling-contract.ts";
import {
  buildPageViewModel,
  initialPage,
  pageViewHref,
  type PageCandidateInput,
  type PageFlagInput,
  type PageSummaryInput,
  type PageViewModelInput,
} from "./page-view-model.ts";
import { goldenWire } from "./test-fixtures.ts";

const RUN = { id: "run-1", sourceName: "flexi.pdf", parserVersion: "docling-2.132.0+norm-5", status: "review_ready" };
const RAW_SHA = "f".repeat(64);

let wire: DoclingParseResponse;
/** Candidates as staged for a mirae_sif run that dropped wire chunk 5 (re-numbered), plus one addendum candidate. */
let candidates: PageCandidateInput[];

function candidateFor(wireIndex: number): PageCandidateInput {
  return candidates.find((candidate) => candidate.id === `cand-w${wireIndex}`)!;
}

function flag(id: string, candidateId: string, overrides: Partial<PageFlagInput> = {}): PageFlagInput {
  return {
    id,
    chunkCandidateId: candidateId,
    ruleCode: "TABLE_ROW_SPLIT",
    severity: "warning",
    blocksApproval: false,
    message: `Finding ${id}`,
    status: "open",
    ...overrides,
  };
}

const SUMMARY: PageSummaryInput[] = [
  { page: 1, chunkCount: 17, openFlagCount: 2, openBlockingCount: 1 },
  { page: 2, chunkCount: 1, openFlagCount: 0, openBlockingCount: 0 },
  { page: 4, chunkCount: 3, openFlagCount: 1, openBlockingCount: 0 },
];

function input(overrides: Partial<PageViewModelInput> = {}): PageViewModelInput {
  const page = overrides.page ?? 1;
  return {
    run: RUN,
    page,
    pageCount: 5,
    rawPdfSha256: RAW_SHA,
    summary: SUMMARY,
    candidates: candidates.filter((candidate) => candidate.pageNumbers.includes(page)),
    flags: [
      flag("f-open", candidateFor(10).id),
      flag("f-done", candidateFor(10).id, { status: "accepted", message: "Already decided" }),
      flag("f-block", candidateFor(2).id, { severity: "critical", blocksApproval: true, ruleCode: "KV_SPLIT" }),
    ],
    editCounts: new Map([[candidateFor(10).id, 2]]),
    wireChunks: wire.chunks.filter((chunk) => chunk.pages.includes(page)),
    ...overrides,
  };
}

beforeAll(async () => {
  wire = await goldenWire("mirae-flexi-cap-p34-35");
  const mapped = mapDoclingChunks(wire).chunkResult.chunks
    .map((chunk) => ({
      id: `cand-w${chunk.chunkIndex}`,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      pageNumbers: chunk.pageNumbers,
      sectionHeader: chunk.sectionHeader,
      metadata: chunk.metadata,
    }))
    .filter((candidate) => candidate.chunkIndex !== 5)
    .map((candidate, chunkIndex) => ({ ...candidate, chunkIndex }));
  candidates = [
    ...mapped,
    {
      id: "cand-addendum",
      chunkIndex: mapped.length,
      text: "Addendum provision on page 1 <b>bold</b>",
      pageNumbers: [1],
      sectionHeader: null,
      metadata: { documentScope: "strategy", documentType: "Addendum" },
    },
  ];
});

describe("buildPageViewModel", () => {
  test("cards are the matched candidates in chunk-index order with their Docling wire record", () => {
    const model = buildPageViewModel(input());

    expect(model.cards).toHaveLength(16);
    expect(model.cards.map((card) => card.chunkIndex)).toEqual(Array.from({ length: 16 }, (_, index) => index));
    const kv = model.cards.find((card) => card.candidateId === "cand-w2")!;
    expect(kv).toMatchObject({
      chunkIndex: 2,
      anchorId: "chunk-2",
      chunkType: "key_value",
      itemRefs: ["#/tables/0"],
      normalizationFlags: ["ordinal_joined", "heading_from_table_title", "kv_panel_detected", "table_span_collapsed"],
      pageNumbers: [1],
      editorHref: "/review/documents/run-1/chunks#cand-w2",
      editCount: 0,
      edited: false,
    });
    expect(kv.wire).toMatchObject({
      chunkIndex: 2,
      type: "key_value",
      headings: ["MIRAE ASSET FLEXI CAP FUND", "Monthly Factsheet as on 31st August 2026", "Fund Details"],
      bboxCount: 1,
      pictureClassification: null,
    });
    // After the dropped wire chunk 5 the candidate index trails the wire index by one.
    const shifted = model.cards.find((card) => card.candidateId === "cand-w11")!;
    expect(shifted.chunkIndex).toBe(10);
    expect(shifted.wire).toMatchObject({ chunkIndex: 11, type: "picture", pictureClassification: "bar_chart" });
  });

  test("lists only open flags per card, with links to the flag on the document review", () => {
    const model = buildPageViewModel(input());

    const table = model.cards.find((card) => card.candidateId === "cand-w10")!;
    const kv = model.cards.find((card) => card.candidateId === "cand-w2")!;
    expect(table.openFlags).toEqual([{
      id: "f-open",
      ruleCode: "TABLE_ROW_SPLIT",
      severity: "warning",
      blocksApproval: false,
      message: "Finding f-open",
      href: "/review/documents/run-1#flag-f-open",
    }]);
    expect(kv.openFlags.map((item) => [item.id, item.blocksApproval])).toEqual([["f-block", true]]);
    expect(table).toMatchObject({ editCount: 2, edited: true });
  });

  test("separates candidates without Docling geometry and wire chunks without candidates", () => {
    const model = buildPageViewModel(input());

    expect(model.candidatesWithoutGeometry.map((card) => [card.candidateId, card.wire])).toEqual([["cand-addendum", null]]);
    expect(model.candidatesWithoutGeometry[0]!.text).toBe("Addendum provision on page 1 <b>bold</b>");
    expect(model.unmatchedWire).toHaveLength(1);
    expect(model.unmatchedWire[0]).toMatchObject({ chunkIndex: 5, anchorId: "wire-5", record: { chunkIndex: 5, type: "text" } });
  });

  test("the JSON payload holds this page's boxes only, linked to their cards", () => {
    const pageOne = buildPageViewModel(input());
    const pageTwo = buildPageViewModel(input({ page: 2 }));

    expect(pageOne.data.page).toBe(1);
    expect(pageOne.data.boxes).toHaveLength(17);
    expect(pageOne.data.boxes[2]).toEqual({
      targetId: "chunk-2",
      candidateId: "cand-w2",
      wireChunkIndex: 2,
      label: "2",
      type: "key_value",
      matched: true,
      bbox: { l: 19.95, t: 687.18, r: 156.7, b: 564.07 },
    });
    expect(pageOne.data.boxes.find((box) => box.wireChunkIndex === 5)).toMatchObject({
      targetId: "wire-5", candidateId: null, label: "w5", matched: false,
    });
    expect(pageOne.data.boxes.find((box) => box.wireChunkIndex === 11)).toMatchObject({ targetId: "chunk-10", label: "10" });
    expect(pageTwo.data.boxes.map((box) => box.wireChunkIndex)).toEqual([17, 18, 19, 20, 21, 22, 23, 24]);
  });

  test("a multi-page wire chunk contributes only the bbox on the current page", () => {
    const spanning: DoclingWireChunk = {
      chunkIndex: 0,
      type: "table",
      text: "Row 1 = 2",
      headings: ["Table"],
      pages: [1, 2],
      bboxes: [{ page: 1, l: 10, t: 100, r: 50, b: 20 }, { page: 2, l: 11, t: 700, r: 51, b: 600 }],
      itemRefs: ["#/tables/0"],
      flags: [],
      picture: null,
    };
    const candidate: PageCandidateInput = {
      id: "c-span",
      chunkIndex: 0,
      text: "Table\nRow 1 = 2",
      pageNumbers: [1, 2],
      sectionHeader: "Table",
      metadata: { parser: "docling", chunkType: "table", sourceItemRefs: ["#/tables/0"], normalizationFlags: [] },
    };

    const model = buildPageViewModel(input({ page: 2, candidates: [candidate], flags: [], wireChunks: [spanning] }));

    expect(model.data.boxes.map((box) => box.bbox)).toEqual([{ l: 11, t: 700, r: 51, b: 600 }]);
    expect(model.cards[0]!.wire?.bboxCount).toBe(1);
  });

  test("navigation: prev/next within bounds and the next page with open findings", () => {
    expect(buildPageViewModel(input({ page: 1 })).nav).toEqual({ prev: null, next: 2, nextWithFindings: 4 });
    expect(buildPageViewModel(input({ page: 2, candidates: [], wireChunks: [] })).nav)
      .toEqual({ prev: 1, next: 3, nextWithFindings: 4 });
    expect(buildPageViewModel(input({ page: 4, candidates: [], wireChunks: [] })).nav)
      .toEqual({ prev: 3, next: 5, nextWithFindings: null });
    expect(buildPageViewModel(input({ page: 5, candidates: [], wireChunks: [] })).nav)
      .toEqual({ prev: 4, next: null, nextWithFindings: null });
  });

  test("the page picker lists every page with chunk and open/blocking counts", () => {
    const model = buildPageViewModel(input({ page: 2, candidates: [], wireChunks: [] }));

    expect(model.picker).toEqual([
      { page: 1, label: "p1 - 17 chunks - 2 open (1 blocking)", selected: false },
      { page: 2, label: "p2 - 1 chunk", selected: true },
      { page: 3, label: "p3 - 0 chunks", selected: false },
      { page: 4, label: "p4 - 3 chunks - 1 open", selected: false },
      { page: 5, label: "p5 - 0 chunks", selected: false },
    ]);
  });

  test("links: versioned PDF URL, document review and candidate editor", () => {
    const model = buildPageViewModel(input({ run: { ...RUN, id: "a b/c" } }));

    expect(model.pdfUrl).toBe(`/review/documents/a%20b%2Fc/source.pdf?v=${RAW_SHA}`);
    expect(model.documentReviewHref).toBe("/review/documents/a%20b%2Fc");
    expect(model.candidateEditorHref).toBe("/review/documents/a%20b%2Fc/chunks");
    expect(model.cards[0]!.editorHref).toBe("/review/documents/a%20b%2Fc/chunks#cand-w0");
    expect(model).toMatchObject({ page: 1, pageCount: 5, run: { id: "a b/c" } });
  });

  test("rejects a page outside 1..pageCount", () => {
    for (const page of [0, 6, 1.5]) {
      expect(() => buildPageViewModel(input({ page, candidates: [], wireChunks: [] }))).toThrow(RangeError);
    }
  });
});

describe("initialPage", () => {
  test("is the first page with open findings, else page 1", () => {
    expect(initialPage(SUMMARY, 5)).toBe(1);
    expect(initialPage(SUMMARY.slice(1), 5)).toBe(4);
    expect(initialPage([{ page: 2, chunkCount: 1, openFlagCount: 0, openBlockingCount: 0 }], 5)).toBe(1);
    expect(initialPage([], 5)).toBe(1);
  });

  test("ignores summary pages beyond the page count", () => {
    expect(initialPage([{ page: 9, chunkCount: 1, openFlagCount: 3, openBlockingCount: 0 }], 5)).toBe(1);
  });
});

describe("pageViewHref", () => {
  test("builds the page route with an encoded run id", () => {
    expect(pageViewHref("run-1", 12)).toBe("/review/documents/run-1/pages/12");
  });
});
