/**
 * Pure bbox geometry shared by the server (tests, view model) and the browser
 * page-view module. No imports: the client bundle includes this file verbatim.
 *
 * Docling bboxes are PDF points with a BOTTOM-LEFT origin (`l < r`, `b < t`).
 * The stored parse artifact has no page sizes, so the page size comes from the
 * pdf.js viewport at scale 1 (`page.getViewport({ scale: 1 })`) in the browser.
 * The result is a TOP-LEFT percent box of that viewport, ready for CSS
 * `left/top/width/height: <n>%` on an overlay sized like the canvas.
 *
 * Assumes the page has no `/Rotate` and a CropBox origin of (0, 0); the client
 * flags pages where that does not hold.
 */

/** One Docling bbox in PDF points, bottom-left origin. */
export interface PageBbox {
  readonly page: number;
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** Page size in PDF points (pdf.js viewport at scale 1). */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

/** Top-left-origin box in percent (0-100) of the page width/height. */
export interface PercentBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A chunk-like record carrying bboxes (a Docling wire chunk satisfies it). */
export interface BboxChunk {
  readonly chunkIndex: number;
  readonly type: string;
  readonly bboxes: readonly PageBbox[];
}

/** One bbox of one chunk on one page. */
export interface PageChunkBox {
  readonly chunkIndex: number;
  readonly type: string;
  readonly bbox: PageBbox;
}

/** Boxes thinner than this (percent of page height) are grown so they stay visible and hoverable. */
export const MIN_BOX_HEIGHT_PERCENT = 0.4;

/**
 * Converts a bottom-left point bbox to a top-left percent box:
 * `left = l/W, top = (H - t)/H, width = (r - l)/W, height = (t - b)/H`, each edge
 * clamped to 0-100, height at least MIN_BOX_HEIGHT_PERCENT (kept inside the page).
 * Throws on a non-positive or non-finite page size.
 */
export function bboxToPercent(bbox: PageBbox, pageSize: PageSize): PercentBox {
  const { width, height } = pageSize;
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
    throw new Error("Page size must be positive and finite.");
  }
  const left = clampPercent((bbox.l / width) * 100);
  const right = clampPercent((bbox.r / width) * 100);
  const top = clampPercent(((height - bbox.t) / height) * 100);
  const bottom = clampPercent(((height - bbox.b) / height) * 100);
  const visibleHeight = Math.max(bottom - top, MIN_BOX_HEIGHT_PERCENT);
  return {
    left,
    top: Math.min(top, 100 - visibleHeight),
    width: right - left,
    height: visibleHeight,
  };
}

/** The bboxes of `chunks` that lie on `page`, in chunk order then bbox order. */
export function boxesForPage(chunks: readonly BboxChunk[], page: number): PageChunkBox[] {
  return chunks.flatMap((chunk) => chunk.bboxes
    .filter((bbox) => bbox.page === page)
    .map((bbox) => ({ chunkIndex: chunk.chunkIndex, type: chunk.type, bbox })));
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
