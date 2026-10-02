import { describe, expect, test } from "bun:test";

import type { DoclingPageStats, DoclingWireChunk } from "../parsers/docling-contract.ts";
import type { DoclingPdfParseArtifact } from "../stages/docling-parse-stage.ts";
import { mapDoclingChunks } from "./docling-chunk-mapper.ts";

const GOLDEN_WIRE_PATH = new URL(
  "../../../../tests/fixtures/docling/mirae-flexi-cap-p34-35.wire.json",
  import.meta.url,
);
const goldenExists = await Bun.file(GOLDEN_WIRE_PATH).exists();

function stats(overrides: Partial<DoclingPageStats> = {}): DoclingPageStats {
  return { textItems: 5, tables: 0, pictures: 0, pictureTextChars: 0, bodyTextChars: 400, ...overrides };
}

function page(pageNumber: number, text: string, pageStats: Partial<DoclingPageStats> = {}) {
  const value = stats(pageStats);
  return { pageNumber, text, hasTable: value.tables > 0, stats: value };
}

function chunk(chunkIndex: number, overrides: Partial<DoclingWireChunk> = {}): DoclingWireChunk {
  return {
    chunkIndex,
    type: "text",
    text: `Body text ${chunkIndex}`,
    headings: ["Section"],
    pages: [1],
    bboxes: [{ page: 1, l: 1, t: 10, r: 10, b: 1 }],
    itemRefs: [`#/texts/${chunkIndex}`],
    flags: [],
    picture: null,
    ...overrides,
  };
}

type MapperInput = Pick<DoclingPdfParseArtifact, "pages" | "chunks">;

describe("mapDoclingChunks", () => {
  test("composes scheme, headings, and body and maps chunk fields", () => {
    const input: MapperInput = {
      pages: [page(1, "Monthly Factsheet\nMIRAE ASSET FLEXI CAP FUND\nFund Details", { tables: 1 })],
      chunks: [
        chunk(0, {
          type: "key_value",
          text: "Net AUM: ₹4,506.259 Cr.",
          headings: ["Monthly Factsheet as on 31st August 2026", "Fund Details"],
          itemRefs: ["#/tables/0"],
          flags: ["kv_panel_detected", "ordinal_joined"],
        }),
        chunk(1, { type: "table", text: "Fund, 1 Year = 10.2%", headings: ["Fund Performance"], itemRefs: ["#/tables/1"] }),
      ],
    };

    const { chunkResult } = mapDoclingChunks(input);
    const [kv, table] = chunkResult.chunks;

    expect(kv!.text).toBe([
      "Mirae Asset Flexi Cap Fund",
      "Monthly Factsheet as on 31st August 2026",
      "Fund Details",
      "Net AUM: ₹4,506.259 Cr.",
    ].join("\n"));
    expect(kv!.sectionHeader).toBe("Fund Details");
    expect(kv!.pageNumbers).toEqual([1]);
    expect(kv!.chunkIndex).toBe(0);
    expect(kv!.hasTable).toBe(false);
    expect(table!.hasTable).toBe(true);
    expect(kv!.tokenCount).toBe(Math.round(kv!.text.trim().split(/\s+/).length * 1.3));
    expect(kv!.metadata).toEqual({
      parser: "docling",
      chunkType: "key_value",
      normalizationFlags: ["kv_panel_detected", "ordinal_joined"],
      sourceItemRefs: ["#/tables/0"],
      fundName: "Mirae Asset Flexi Cap Fund",
    });
    expect(chunkResult.totalChunks).toBe(2);
    expect(chunkResult.totalTokens).toBe(kv!.tokenCount + table!.tokenCount);
  });

  test("does not repeat the scheme name when the chunk already contains it", () => {
    const { chunkResult } = mapDoclingChunks({
      pages: [page(1, "MIRAE ASSET FLEXI CAP FUND\nbody")],
      chunks: [chunk(0, { headings: ["MIRAE ASSET FLEXI CAP FUND"], text: "Investment objective text" })],
    });

    expect(chunkResult.chunks[0]!.text).toBe("MIRAE ASSET FLEXI CAP FUND\nInvestment objective text");
    expect(chunkResult.chunks[0]!.metadata?.fundName).toBe("Mirae Asset Flexi Cap Fund");
  });

  test("stamps only pages with a scheme title line and never carries a scheme forward", () => {
    const { chunkResult } = mapDoclingChunks({
      pages: [
        page(1, "MIRAE ASSET FLEXI CAP FUND\nbody"),
        page(2, "Disclaimers and glossary"),
        page(3, "MIRAE ASSET LARGE CAP FUND\nbody"),
      ],
      chunks: [
        chunk(0, { pages: [1] }),
        chunk(1, { pages: [2], bboxes: [{ page: 2, l: 1, t: 10, r: 10, b: 1 }] }),
        chunk(2, {
          pages: [1, 3],
          bboxes: [{ page: 1, l: 1, t: 10, r: 10, b: 1 }, { page: 3, l: 1, t: 10, r: 10, b: 1 }],
        }),
        chunk(3, {
          pages: [1, 2],
          bboxes: [{ page: 1, l: 1, t: 10, r: 10, b: 1 }, { page: 2, l: 1, t: 10, r: 10, b: 1 }],
        }),
      ],
    });
    const [onScheme, untitled, crossScheme, partlyTitled] = chunkResult.chunks;

    expect(onScheme!.metadata?.fundName).toBe("Mirae Asset Flexi Cap Fund");
    for (const unstamped of [untitled!, crossScheme!, partlyTitled!]) {
      expect(unstamped.metadata).not.toHaveProperty("fundName");
      expect(unstamped.text.startsWith("Section\n")).toBe(true);
    }
  });

  test("maps picture classification and hasTable only for table chunks", () => {
    const { chunkResult } = mapDoclingChunks({
      pages: [page(1, "no title")],
      chunks: [
        chunk(0, {
          type: "picture",
          text: "Regular Direct Benchmark\n10.1 11.2 9.8",
          itemRefs: ["#/pictures/3"],
          flags: ["picture_text_recovered", "chart_multi_series_unparsed"],
          picture: { classification: "bar_chart", confidence: 0.9, pairCount: 0 },
        }),
      ],
    });

    expect(chunkResult.chunks[0]!.hasTable).toBe(false);
    expect(chunkResult.chunks[0]!.metadata).toEqual({
      parser: "docling",
      chunkType: "picture",
      normalizationFlags: ["picture_text_recovered", "chart_multi_series_unparsed"],
      sourceItemRefs: ["#/pictures/3"],
      pictureClassification: "bar_chart",
    });
  });

  test("reports low-structure and uncovered pages", () => {
    const { parserDiagnostics } = mapDoclingChunks({
      pages: [
        page(1, "covered"),
        page(2, "", { textItems: 0, tables: 0, pictures: 0, bodyTextChars: 0 }),
        page(3, "chart only", { textItems: 1, pictures: 2, bodyTextChars: 20 }),
        page(4, "short text, no pictures", { textItems: 1, bodyTextChars: 20 }),
        page(5, "long body nobody references", { bodyTextChars: 80 }),
      ],
      chunks: [chunk(0, { pages: [1] })],
    });

    expect(parserDiagnostics).toEqual({ lowStructurePages: [2, 3], uncoveredPages: [5] });
  });

  test.skipIf(!goldenExists)("maps the golden Flexi Cap wire response end to end", async () => {
    const wire = await Bun.file(GOLDEN_WIRE_PATH).json() as MapperInput & { readonly chunks: DoclingWireChunk[] };
    const { chunkResult } = mapDoclingChunks(wire);

    expect(chunkResult.chunks.map((item) => item.metadata?.chunkType))
      .toEqual(wire.chunks.map((item) => item.type));
    for (const [index, mapped] of chunkResult.chunks.entries()) {
      const source = wire.chunks[index]!;
      expect(mapped.pageNumbers).toEqual([...source.pages]);
      expect(mapped.hasTable).toBe(source.type === "table");
      expect(mapped.metadata?.fundName).toBe("Mirae Asset Flexi Cap Fund");
      expect(mapped.text.toLowerCase()).toContain("mirae asset flexi cap fund");
    }
  });
});
