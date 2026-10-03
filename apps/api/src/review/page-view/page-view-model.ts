/**
 * Pure view model for one page of a Docling review run: the right-hand cards
 * (candidates on the page with their Docling wire record and open findings),
 * the page picker and navigation, and the JSON box payload the browser module
 * draws over the pdf.js canvas. No I/O; inputs come from `getReviewRunPage`,
 * `getReviewRunPageSummary` and `ReviewSourceArtifacts`.
 */

import type { DoclingWireChunk } from "../../../../ingestion/src/parsers/docling-contract.ts";
import { alignCandidatesToWire } from "./chunk-alignment.ts";
import { boxesForPage, type PageBbox } from "./geometry.ts";

/** Candidate fields the page view reads (a `chunk_candidates` row satisfies it). */
export interface PageCandidateInput {
  readonly id: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly pageNumbers: readonly number[];
  readonly sectionHeader: string | null;
  readonly metadata: unknown;
}

/** Flag fields the page view reads (a `chunk_flags` row satisfies it). */
export interface PageFlagInput {
  readonly id: string;
  readonly chunkCandidateId: string | null;
  readonly ruleCode: string;
  readonly severity: string;
  readonly blocksApproval: boolean;
  readonly message: string;
  readonly status: string;
}

/** One row of `getReviewRunPageSummary`; pages without candidates are absent. */
export interface PageSummaryInput {
  readonly page: number;
  readonly chunkCount: number;
  readonly openFlagCount: number;
  readonly openBlockingCount: number;
}

export interface PageViewModelInput {
  readonly run: {
    readonly id: string;
    readonly sourceName: string;
    readonly parserVersion: string;
    readonly status: string;
  };
  /** 1-based; must lie within 1..pageCount. */
  readonly page: number;
  /** From the decoded parse artifact (`diagnostics.pageCount`). */
  readonly pageCount: number;
  /** Raw PDF sha256; versions the immutable `source.pdf?v=` URL. */
  readonly rawPdfSha256: string;
  readonly summary: readonly PageSummaryInput[];
  /** Candidates whose pageNumbers include `page`. */
  readonly candidates: readonly PageCandidateInput[];
  /** Flags of those candidates (any status; only `open` ones are shown). */
  readonly flags: readonly PageFlagInput[];
  /** Number of `chunk_candidate_edits` rows per candidate id. */
  readonly editCounts: ReadonlyMap<string, number>;
  /** Wire chunks whose pages include `page`. */
  readonly wireChunks: readonly DoclingWireChunk[];
}

export interface PageFlagSummary {
  readonly id: string;
  readonly ruleCode: string;
  readonly severity: string;
  readonly blocksApproval: boolean;
  readonly message: string;
  /** `/review/documents/:runId#flag-<id>` */
  readonly href: string;
}

/** The Docling record of a matched candidate (shown in a `<details>`). */
export interface PageWireRecord {
  readonly chunkIndex: number;
  readonly type: string;
  readonly headings: readonly string[];
  readonly text: string;
  readonly pages: readonly number[];
  readonly itemRefs: readonly string[];
  readonly flags: readonly string[];
  readonly pictureClassification: string | null;
  /** Bboxes on this page. */
  readonly bboxCount: number;
}

export interface PageCandidateCard {
  readonly candidateId: string;
  readonly chunkIndex: number;
  /** `chunk-<chunkIndex>`; deep links (`#chunk-<n>`) and flag "View page N" links target it. */
  readonly anchorId: string;
  /** Candidate text: what reviewers approve, edit and publish. */
  readonly text: string;
  readonly sectionHeader: string | null;
  readonly pageNumbers: readonly number[];
  /** From candidate metadata (`chunkType`, `normalizationFlags`, `sourceItemRefs`). */
  readonly chunkType: string | null;
  readonly normalizationFlags: readonly string[];
  readonly itemRefs: readonly string[];
  readonly editCount: number;
  readonly edited: boolean;
  /** `/review/documents/:runId/chunks#<candidateId>` */
  readonly editorHref: string;
  readonly openFlags: readonly PageFlagSummary[];
  /** Null for candidates without Docling geometry. */
  readonly wire: PageWireRecord | null;
}

/** A wire chunk on the page that no candidate maps to (drawn dashed). */
export interface UnmatchedWireCard {
  readonly chunkIndex: number;
  /** `wire-<chunkIndex>` */
  readonly anchorId: string;
  readonly record: PageWireRecord;
}

export interface PagePickerOption {
  readonly page: number;
  /** `p12 - 7 chunks - 2 open (1 blocking)`; open/blocking parts only when non-zero. */
  readonly label: string;
  readonly selected: boolean;
}

export interface PageNavigation {
  readonly prev: number | null;
  readonly next: number | null;
  /** First page after this one with open findings; null when none. */
  readonly nextWithFindings: number | null;
}

/** One overlay box; serialized into the page's JSON data block. */
export interface PageViewBox {
  /** Card element id the box highlights/selects (`chunk-<n>` or `wire-<n>`). */
  readonly targetId: string;
  readonly candidateId: string | null;
  readonly wireChunkIndex: number;
  /** Tag drawn on the box: candidate chunk index when matched, else `w<wire index>`. */
  readonly label: string;
  readonly type: string;
  readonly matched: boolean;
  readonly bbox: Omit<PageBbox, "page">;
}

/** Client payload: this page's boxes only. */
export interface PageViewData {
  readonly page: number;
  readonly boxes: readonly PageViewBox[];
}

export interface PageViewModel {
  readonly run: PageViewModelInput["run"];
  readonly page: number;
  readonly pageCount: number;
  /** `/review/documents/:runId/source.pdf?v=<sha256>` */
  readonly pdfUrl: string;
  readonly documentReviewHref: string;
  readonly candidateEditorHref: string;
  readonly nav: PageNavigation;
  readonly picker: readonly PagePickerOption[];
  /** Candidates with Docling geometry, in chunk-index order. */
  readonly cards: readonly PageCandidateCard[];
  /** Candidates on the page without Docling geometry, in chunk-index order. */
  readonly candidatesWithoutGeometry: readonly PageCandidateCard[];
  readonly unmatchedWire: readonly UnmatchedWireCard[];
  readonly data: PageViewData;
}

/** `/review/documents/:runId/pages/:page` */
export function pageViewHref(runId: string, page: number): string {
  return `${documentHref(runId)}/pages/${page}`;
}

/** First page with open findings, else 1 (target of `GET /documents/:runId/pages`). */
export function initialPage(summary: readonly PageSummaryInput[], pageCount: number): number {
  return pageWithFindingsAfter(summary, 0, pageCount) ?? 1;
}

export function buildPageViewModel(input: PageViewModelInput): PageViewModel {
  const { run, page, pageCount } = input;
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new RangeError(`Page ${page} is outside 1..${pageCount}.`);
  }
  const alignment = alignCandidatesToWire(input.candidates, input.wireChunks);
  const openFlags = openFlagsByCandidate(run.id, input.flags);
  const card = (candidate: PageCandidateInput, wire: DoclingWireChunk | null): PageCandidateCard => {
    const metadata = metadataFields(candidate.metadata);
    const editCount = input.editCounts.get(candidate.id) ?? 0;
    return {
      candidateId: candidate.id,
      chunkIndex: candidate.chunkIndex,
      anchorId: `chunk-${candidate.chunkIndex}`,
      text: candidate.text,
      sectionHeader: candidate.sectionHeader,
      pageNumbers: candidate.pageNumbers,
      chunkType: metadata.chunkType,
      normalizationFlags: metadata.normalizationFlags,
      itemRefs: metadata.sourceItemRefs,
      editCount,
      edited: editCount > 0,
      editorHref: `${documentHref(run.id)}/chunks#${encodeURIComponent(candidate.id)}`,
      openFlags: openFlags.get(candidate.id) ?? [],
      wire: wire ? wireRecord(wire, page) : null,
    };
  };
  const cards = alignment.pairs.map(({ candidate, wire }) => card(candidate, wire));
  const candidateByWire = new Map(alignment.pairs.map(({ candidate, wire }) => [wire.chunkIndex, candidate]));
  const boxes = boxesForPage(input.wireChunks, page).map(({ chunkIndex, type, bbox }): PageViewBox => {
    const candidate = candidateByWire.get(chunkIndex);
    return {
      targetId: candidate ? `chunk-${candidate.chunkIndex}` : `wire-${chunkIndex}`,
      candidateId: candidate?.id ?? null,
      wireChunkIndex: chunkIndex,
      label: candidate ? String(candidate.chunkIndex) : `w${chunkIndex}`,
      type,
      matched: Boolean(candidate),
      bbox: { l: bbox.l, t: bbox.t, r: bbox.r, b: bbox.b },
    };
  });
  const summaryByPage = new Map(input.summary.map((row) => [row.page, row]));
  return {
    run,
    page,
    pageCount,
    pdfUrl: `${documentHref(run.id)}/source.pdf?v=${encodeURIComponent(input.rawPdfSha256)}`,
    documentReviewHref: documentHref(run.id),
    candidateEditorHref: `${documentHref(run.id)}/chunks`,
    nav: {
      prev: page > 1 ? page - 1 : null,
      next: page < pageCount ? page + 1 : null,
      nextWithFindings: pageWithFindingsAfter(input.summary, page, pageCount),
    },
    picker: Array.from({ length: pageCount }, (_, index) => {
      const pageNumber = index + 1;
      return { page: pageNumber, label: pickerLabel(pageNumber, summaryByPage.get(pageNumber)), selected: pageNumber === page };
    }),
    cards,
    candidatesWithoutGeometry: alignment.unmatchedCandidates.map((candidate) => card(candidate, null)),
    unmatchedWire: alignment.unmatchedWire.map((wire) => ({
      chunkIndex: wire.chunkIndex,
      anchorId: `wire-${wire.chunkIndex}`,
      record: wireRecord(wire, page),
    })),
    data: { page, boxes },
  };
}

function documentHref(runId: string): string {
  return `/review/documents/${encodeURIComponent(runId)}`;
}

function pageWithFindingsAfter(summary: readonly PageSummaryInput[], page: number, pageCount: number): number | null {
  const pages = summary
    .filter((row) => row.openFlagCount > 0 && row.page > page && row.page <= pageCount)
    .map((row) => row.page);
  return pages.length ? Math.min(...pages) : null;
}

function pickerLabel(page: number, row: PageSummaryInput | undefined): string {
  const chunkCount = row?.chunkCount ?? 0;
  const parts = [`p${page}`, `${chunkCount} ${chunkCount === 1 ? "chunk" : "chunks"}`];
  if (row && row.openFlagCount > 0) {
    parts.push(`${row.openFlagCount} open${row.openBlockingCount > 0 ? ` (${row.openBlockingCount} blocking)` : ""}`);
  }
  return parts.join(" - ");
}

function openFlagsByCandidate(runId: string, flags: readonly PageFlagInput[]): Map<string, PageFlagSummary[]> {
  const byCandidate = new Map<string, PageFlagSummary[]>();
  for (const flag of flags) {
    if (flag.status !== "open" || !flag.chunkCandidateId) continue;
    const list = byCandidate.get(flag.chunkCandidateId) ?? [];
    list.push({
      id: flag.id,
      ruleCode: flag.ruleCode,
      severity: flag.severity,
      blocksApproval: flag.blocksApproval,
      message: flag.message,
      href: `${documentHref(runId)}#flag-${encodeURIComponent(flag.id)}`,
    });
    byCandidate.set(flag.chunkCandidateId, list);
  }
  return byCandidate;
}

function wireRecord(wire: DoclingWireChunk, page: number): PageWireRecord {
  return {
    chunkIndex: wire.chunkIndex,
    type: wire.type,
    headings: wire.headings,
    text: wire.text,
    pages: wire.pages,
    itemRefs: wire.itemRefs,
    flags: wire.flags,
    pictureClassification: wire.picture?.classification ?? null,
    bboxCount: wire.bboxes.filter((bbox) => bbox.page === page).length,
  };
}

function metadataFields(metadata: unknown): {
  chunkType: string | null;
  normalizationFlags: string[];
  sourceItemRefs: string[];
} {
  const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    chunkType: typeof record.chunkType === "string" ? record.chunkType : null,
    normalizationFlags: strings(record.normalizationFlags),
    sourceItemRefs: strings(record.sourceItemRefs),
  };
}
