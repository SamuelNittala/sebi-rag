import { describe, expect, test } from "bun:test";

import { bboxToPercent, boxesForPage, MIN_BOX_HEIGHT_PERCENT, type PercentBox } from "./geometry.ts";

/** Page size of the flexi-cap p34-35 fixture (A4 at 72 dpi, as Docling and pdf.js report it). */
const A4 = { width: 594.96, height: 841.92 };

function expectBox(actual: PercentBox, expected: PercentBox): void {
  expect(actual.left).toBeCloseTo(expected.left, 6);
  expect(actual.top).toBeCloseTo(expected.top, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

describe("bboxToPercent", () => {
  test("converts a bottom-left point bbox to a top-left percent box", () => {
    // Chunk 0 of the flexi-cap fixture (page heading near the top of the page).
    const box = bboxToPercent({ page: 1, l: 45.15, t: 801.08, r: 460.81, b: 775.83 }, A4);

    expectBox(box, {
      left: (45.15 / 594.96) * 100,
      top: ((841.92 - 801.08) / 841.92) * 100,
      width: ((460.81 - 45.15) / 594.96) * 100,
      height: ((801.08 - 775.83) / 841.92) * 100,
    });
    expect(box.top).toBeLessThan(5);
  });

  test("a bbox at the PDF bottom-left corner lands at the bottom-left of the viewport", () => {
    const box = bboxToPercent({ page: 1, l: 0, t: 84.192, r: 59.496, b: 0 }, A4);

    expectBox(box, { left: 0, top: 90, width: 10, height: 10 });
  });

  test("the full page maps to 0/0/100/100", () => {
    expectBox(bboxToPercent({ page: 1, l: 0, t: 841.92, r: 594.96, b: 0 }, A4), {
      left: 0, top: 0, width: 100, height: 100,
    });
  });

  test("uses the given page size, not a fixed A4 frame", () => {
    // Passive factsheet pages are 930 x 1315.92 points.
    const box = bboxToPercent({ page: 1, l: 465, t: 657.96, r: 930, b: 0 }, { width: 930, height: 1315.92 });

    expectBox(box, { left: 50, top: 50, width: 50, height: 50 });
  });

  test("grows hairline boxes to the minimum visible height", () => {
    const box = bboxToPercent({ page: 1, l: 10, t: 400.5, r: 100, b: 400 }, A4);

    expect(box.height).toBeCloseTo(MIN_BOX_HEIGHT_PERCENT, 6);
    expect(box.top).toBeCloseTo(((841.92 - 400.5) / 841.92) * 100, 6);
  });

  test("keeps a grown box at the page bottom inside the page", () => {
    const box = bboxToPercent({ page: 1, l: 10, t: 0.5, r: 100, b: 0 }, A4);

    expect(box.height).toBeCloseTo(MIN_BOX_HEIGHT_PERCENT, 6);
    expect(box.top + box.height).toBeCloseTo(100, 6);
  });

  test("clamps boxes that extend beyond the page to 0-100", () => {
    const box = bboxToPercent({ page: 1, l: -20, t: 900, r: 700, b: -10 }, A4);

    expectBox(box, { left: 0, top: 0, width: 100, height: 100 });
  });

  test("clamps a box partially off the right and top edges", () => {
    const box = bboxToPercent({ page: 1, l: 297.48, t: 1000, r: 800, b: 420.96 }, A4);

    expectBox(box, { left: 50, top: 0, width: 50, height: 50 });
  });

  test("rejects non-positive or non-finite page sizes", () => {
    const bbox = { page: 1, l: 1, t: 2, r: 2, b: 1 };
    for (const size of [
      { width: 0, height: 841.92 },
      { width: 594.96, height: -1 },
      { width: Number.NaN, height: 841.92 },
      { width: 594.96, height: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => bboxToPercent(bbox, size)).toThrow("Page size");
    }
  });
});

describe("boxesForPage", () => {
  const chunks = [
    { chunkIndex: 0, type: "text", bboxes: [{ page: 1, l: 1, t: 20, r: 10, b: 10 }] },
    {
      chunkIndex: 1,
      type: "table",
      bboxes: [
        { page: 1, l: 1, t: 9, r: 10, b: 1 },
        { page: 2, l: 1, t: 800, r: 10, b: 700 },
      ],
    },
    { chunkIndex: 2, type: "picture", bboxes: [{ page: 2, l: 5, t: 50, r: 50, b: 5 }] },
  ];

  test("keeps only the bboxes on the page, in chunk then bbox order", () => {
    expect(boxesForPage(chunks, 1)).toEqual([
      { chunkIndex: 0, type: "text", bbox: { page: 1, l: 1, t: 20, r: 10, b: 10 } },
      { chunkIndex: 1, type: "table", bbox: { page: 1, l: 1, t: 9, r: 10, b: 1 } },
    ]);
  });

  test("a multi-page chunk contributes only its box on the requested page", () => {
    expect(boxesForPage(chunks, 2)).toEqual([
      { chunkIndex: 1, type: "table", bbox: { page: 2, l: 1, t: 800, r: 10, b: 700 } },
      { chunkIndex: 2, type: "picture", bbox: { page: 2, l: 5, t: 50, r: 50, b: 5 } },
    ]);
  });

  test("returns nothing for a page without boxes", () => {
    expect(boxesForPage(chunks, 3)).toEqual([]);
  });
});
