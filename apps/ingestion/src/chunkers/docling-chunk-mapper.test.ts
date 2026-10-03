import { describe, expect, test } from "bun:test";

import type { DoclingPageStats, DoclingWireChunk } from "../parsers/docling-contract.ts";
import type { DoclingPdfParseArtifact } from "../stages/docling-parse-stage.ts";
import { mapDoclingChunks, pageSchemeNames } from "./docling-chunk-mapper.ts";

const GOLDEN_DIR = new URL("../../../../tests/fixtures/docling/", import.meta.url);
const GOLDEN_WIRE_PATH = new URL("mirae-flexi-cap-p34-35.wire.json", GOLDEN_DIR);
const goldenExists = await Bun.file(GOLDEN_WIRE_PATH).exists();

async function golden(stem: string): Promise<MapperInput & { readonly chunks: DoclingWireChunk[] }> {
  return await Bun.file(new URL(`${stem}.wire.json`, GOLDEN_DIR)).json();
}

function fundNames(input: MapperInput): (string | undefined)[] {
  return mapDoclingChunks(input).chunkResult.chunks.map((item) => item.metadata?.fundName as string | undefined);
}

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
        chunk(2, { headings: ["MIRAE ASSET FLEXI CAP FUND"], text: "An open ended dynamic equity scheme" }),
      ],
    };

    const { chunkResult } = mapDoclingChunks(input);
    const [kv, table, title] = chunkResult.chunks;

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
    expect(chunkResult.totalChunks).toBe(3);
    expect(chunkResult.totalTokens).toBe(kv!.tokenCount + table!.tokenCount + title!.tokenCount);
  });

  test("does not repeat the scheme name when the chunk already contains it", () => {
    const { chunkResult } = mapDoclingChunks({
      pages: [page(1, "MIRAE ASSET FLEXI CAP FUND\nbody")],
      chunks: [chunk(0, { headings: ["MIRAE ASSET FLEXI CAP FUND"], text: "Investment objective text" })],
    });

    expect(chunkResult.chunks[0]!.text).toBe("MIRAE ASSET FLEXI CAP FUND\nInvestment objective text");
    expect(chunkResult.chunks[0]!.metadata?.fundName).toBe("Mirae Asset Flexi Cap Fund");
  });

  test("a chunk's own nearest scheme heading wins over the page", () => {
    const names = fundNames({
      pages: [page(1, "MIRAE ASSET LARGE CAP FUND\nbody")],
      chunks: [
        chunk(0, { headings: ["MIRAE ASSET LARGE CAP FUND"] }),
        chunk(1, {
          headings: ["Monthly Factsheet", "Mirae Asset Liquid Fund - Fund Managers - Ms. Pranavi Kulkarni", "NAV as on"],
        }),
        chunk(2, {
          headings: ["Mirae Asset BSE Sensex ETF (NSE Symbol: SENSEXETF , BSE Scrip Code: 543999) - Fund Managers - Ms. Ekta Gala"],
        }),
        chunk(3, {
          headings: ["Mirae Asset Ultra Short to Short Term Fund* (Erstwhile known as Mirae Asset Low Duration Fund)"],
        }),
        // A former name is never the scheme, even as the nearest heading.
        chunk(4, {
          headings: [
            "MIRAE ASSET DIVERSIFIED EQUITY ALLOCATOR PASSIVE FOF*",
            "Formerly Known as Mirae Asset Equity Allocator Fund of Fund",
          ],
        }),
        chunk(5, {
          headings: ["Mirae Asset Diversified Equity Allocator Passive FOF ε (Formerly Known as Mirae Asset Equity Allocator Fund of Fund) - Fund Managers - Ms. Bharti Sawant"],
        }),
      ],
    });

    expect(names).toEqual([
      "Mirae Asset Large Cap Fund",
      "Mirae Asset Liquid Fund",
      "Mirae Asset BSE Sensex ETF",
      "Mirae Asset Ultra Short to Short Term Fund",
      "Mirae Asset Diversified Equity Allocator Passive FOF",
      "Mirae Asset Diversified Equity Allocator Passive FOF",
    ]);
  });

  test("page fallback only when the page's headings name exactly one scheme", () => {
    const onPage = (pageNumber: number, overrides: Partial<DoclingWireChunk>) =>
      chunk(0, { pages: [pageNumber], bboxes: [{ page: pageNumber, l: 1, t: 10, r: 10, b: 1 }], ...overrides });
    const input: MapperInput = {
      pages: [
        page(1, "MIRAE ASSET FLEXI CAP FUND"),
        page(2, "MIRAE ASSET LARGE CAP FUND\nMirae Asset Midcap Fund"),
        page(3, "MIRAE ASSET NIFTY 50 ETF\nOur Passive Fund Offerings"),
        page(4, "Disclaimers and glossary"),
        page(5, "MIRAE ASSET GOLD ETF"),
      ],
      chunks: [
        // Page 1: one scheme, spelled three ways (case and spacing, footnote marker, erstwhile note).
        onPage(1, { headings: ["MIRAE ASSET FLEXI CAP FUND"] }),
        onPage(1, { headings: ["Mirae Asset  Flexi Cap Fund^"] }),
        onPage(1, { headings: ["Mirae Asset Flexi Cap Fund (Erstwhile known as Mirae Asset Multicap Fund)"] }),
        onPage(1, { headings: ["Fund Details"], text: "Net AUM: 4,506 Cr." }),
        // Page 2: two schemes in headings -> a chunk without its own stays unstamped.
        onPage(2, { headings: ["Mirae Asset Large Cap Fund - Fund Managers - Mr. Gaurav Misra"] }),
        onPage(2, { headings: ["Mirae Asset Midcap Fund - Fund Managers - Mr. Ankur Arora"] }),
        onPage(2, { headings: ["Monthly Factsheet as on 31 August, 2026"], text: "Returns are CAGR" }),
        // Page 3: scheme only in body text (a list of funds), none in headings.
        onPage(3, { headings: ["Our Passive Fund Offerings", "Domestic broad based offerings"], text: "- Mirae Asset Nifty 50 ETF" }),
        onPage(4, { headings: [] }),
        onPage(4, { headings: ["Mirae Asset Active FOF Snapshot", "August 2026"] }), // a category overview, not a scheme
        // Page 5: a trailing "Fund" does not make a second scheme.
        onPage(5, { headings: ["Mirae Asset Gold ETF"] }),
        onPage(5, { headings: ["MIRAE ASSET GOLD ETF FUND"] }),
        onPage(5, { headings: ["Portfolio"] }),
      ],
    };
    const { chunkResult } = mapDoclingChunks(input);
    const names = chunkResult.chunks.map((item) => item.metadata?.fundName);

    expect(names).toEqual([
      "Mirae Asset Flexi Cap Fund",
      "Mirae Asset Flexi Cap Fund",
      "Mirae Asset Flexi Cap Fund",
      "Mirae Asset Flexi Cap Fund",
      "Mirae Asset Large Cap Fund",
      "Mirae Asset Midcap Fund",
      undefined,
      undefined,
      undefined,
      undefined,
      "Mirae Asset Gold ETF",
      "Mirae Asset Gold ETF Fund",
      "Mirae Asset Gold ETF",
    ]);
    expect(chunkResult.chunks[3]!.text).toBe("Mirae Asset Flexi Cap Fund\nFund Details\nNet AUM: 4,506 Cr.");
    expect(chunkResult.chunks[6]!.text).toBe("Monthly Factsheet as on 31 August, 2026\nReturns are CAGR");
    expect(chunkResult.chunks[7]!.text.startsWith("Our Passive Fund Offerings\n")).toBe(true);
    expect(pageSchemeNames(input.chunks)).toEqual(new Map([
      [1, ["Mirae Asset Flexi Cap Fund"]],
      [2, ["Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund"]],
      [3, []],
      [4, []],
      [5, ["Mirae Asset Gold ETF"]],
    ]));
  });

  test("never carries a scheme to another page or across pages that disagree", () => {
    const { chunkResult } = mapDoclingChunks({
      pages: [page(1, "a"), page(2, "b"), page(3, "c")],
      chunks: [
        chunk(0, { pages: [1], headings: ["MIRAE ASSET FLEXI CAP FUND"] }),
        chunk(1, { pages: [2], bboxes: [{ page: 2, l: 1, t: 10, r: 10, b: 1 }] }),
        chunk(2, { pages: [3], headings: ["MIRAE ASSET LARGE CAP FUND"], bboxes: [{ page: 3, l: 1, t: 10, r: 10, b: 1 }] }),
        chunk(3, {
          pages: [1, 3],
          bboxes: [{ page: 1, l: 1, t: 10, r: 10, b: 1 }, { page: 3, l: 1, t: 10, r: 10, b: 1 }],
        }),
        chunk(4, {
          pages: [1, 2],
          bboxes: [{ page: 1, l: 1, t: 10, r: 10, b: 1 }, { page: 2, l: 1, t: 10, r: 10, b: 1 }],
        }),
      ],
    });
    const [onScheme, untitled, , crossScheme, partlyTitled] = chunkResult.chunks;

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

  describe("fundName on the golden wire responses", () => {
    test("passive p34: every chunk is the Healthcare ETF", async () => {
      const names = fundNames(await golden("mirae-passive-etf-p34"));
      expect(new Set(names)).toEqual(new Set(["Mirae Asset Nifty 500 Healthcare ETF"]));
    });

    test("SIP p103: each sub-table chunk gets its own fund", async () => {
      expect(fundNames(await golden("mirae-sip-performance-p103"))).toEqual([
        "Mirae Asset Large Cap Fund",
        "Mirae Asset Liquid Fund",
        "Mirae Asset Large & Midcap Fund",
        "Mirae Asset Great Consumer Fund",
        "Mirae Asset Ultra Short to Short Term Fund",
        "Mirae Asset Aggressive Hybrid Fund",
      ]);
    });

    test("fund performance p88: per-table fund, page-level chunks empty", async () => {
      const wire = await golden("mirae-fund-performance-p88");
      const names = fundNames(wire);
      expect(names[0]).toBeUndefined(); // `Monthly Factsheet as on ...`, no headings
      expect(names.slice(1)).toEqual([
        ...Array(3).fill("Mirae Asset Large Cap Fund"),
        ...Array(2).fill("Mirae Asset Liquid Fund"),
        ...Array(3).fill("Mirae Asset Large & Midcap Fund"),
        ...Array(2).fill("Mirae Asset Great Consumer Fund"),
      ]);
      const { chunkResult } = mapDoclingChunks(wire);
      expect(chunkResult.chunks[0]!.text).toBe("Monthly Factsheet as on 31 August, 2026");
    });

    test("fund facts p10 (many funds, none in headings): empty", async () => {
      const wire = await golden("mirae-fund-facts-p10");
      expect(fundNames(wire).every((name) => name === undefined)).toBe(true);
      const { chunkResult } = mapDoclingChunks(wire);
      expect(chunkResult.chunks[0]!.text.startsWith("Mirae Asset Equity Snapshot\nAugust 2026\n")).toBe(true);
    });

    test("passive p9 offerings list: empty, nothing prepended", async () => {
      const wire = await golden("mirae-passive-offerings-p9");
      const { chunkResult } = mapDoclingChunks(wire);
      expect(chunkResult.chunks).toHaveLength(6);
      for (const mapped of chunkResult.chunks) {
        expect(mapped.metadata).not.toHaveProperty("fundName");
        expect(mapped.text.startsWith("Our Passive Fund Offerings\n")).toBe(true);
      }
    });
  });
});
