import { describe, expect, test } from "bun:test";

import {
  DOCLING_CHUNK_TYPES,
  DOCLING_FLAGS_BY_CHUNK_TYPE,
  DOCLING_NORMALIZATION_FLAGS,
  assertDoclingParseResponse,
} from "./docling-contract.ts";

const SCHEMA_PATH = new URL("../../../../python/docling_service/contract/docling-parse-v1.schema.json", import.meta.url);
const OPTIONS_SHA = "3f9a1c2b7d10".padEnd(64, "0");

function minimalResponse(): any {
  return {
    schemaVersion: 1,
    producer: {
      parserVersion: "docling-2.132.0+norm-1+opts-3f9a1c2b7d10",
      serviceVersion: "1.0.0",
      doclingVersion: "2.132.0",
      doclingCoreVersion: "2.99.0",
      doclingIbmModelsVersion: "4.0.3",
      normalizerVersion: "1",
      pipelineOptionsSha256: OPTIONS_SHA,
    },
    source: { sha256: "a".repeat(64), byteSize: 487589 },
    pageCount: 2,
    pages: [
      {
        pageNumber: 1,
        width: 595,
        height: 842,
        text: "MIRAE ASSET FLEXI CAP FUND\nDate of Inception/ Allotment: 24th February 2023",
        hasTable: true,
        stats: { textItems: 2, tables: 1, pictures: 1, pictureTextChars: 40, bodyTextChars: 80 },
      },
      {
        pageNumber: 2,
        width: 595,
        height: 842,
        text: "",
        hasTable: false,
        stats: { textItems: 0, tables: 0, pictures: 1, pictureTextChars: 30, bodyTextChars: 0 },
      },
    ],
    chunks: [
      {
        chunkIndex: 0,
        type: "key_value",
        text: "Date of Inception/ Allotment: 24th February 2023\nNet AUM: ₹4,506.259 Cr.",
        headings: ["Monthly Factsheet as on 31st August 2026", "Fund Details"],
        pages: [1],
        bboxes: [{ page: 1, l: 20.1, t: 610.2, r: 290.4, b: 480.7 }],
        itemRefs: ["#/tables/0"],
        flags: ["kv_panel_detected", "table_span_collapsed", "ordinal_joined", "heading_from_table_title"],
        picture: null,
      },
      {
        chunkIndex: 1,
        type: "picture",
        text: "Allocation of Net Assets by Sectors\nBanks: 16.61%",
        headings: ["Portfolio Data"],
        pages: [2],
        bboxes: [{ page: 2, l: 19.3, t: 777.3, r: 294.7, b: 578.7 }],
        itemRefs: ["#/pictures/5"],
        flags: ["picture_text_recovered", "chart_pairs_extracted"],
        picture: { classification: "bar_chart", confidence: 0.93, pairCount: 1 },
      },
    ],
    diagnostics: {
      droppedPictures: { logo: 2, signature: 0, stamp: 0, qrCode: 0, barCode: 0, noText: 0 },
      flagCounts: {
        kv_panel_detected: 1,
        table_span_collapsed: 1,
        ordinal_joined: 1,
        heading_from_table_title: 1,
        picture_text_recovered: 1,
        chart_pairs_extracted: 1,
      },
      conversionStatus: "success",
      conversionMs: 18120,
    },
  };
}

function textChunk(chunkIndex: number): any {
  return {
    chunkIndex,
    type: "text",
    text: "Portfolio Turnover Ratio: 0.42 times",
    headings: [],
    pages: [1, 2],
    bboxes: [{ page: 1, l: 1, t: 2, r: 2, b: 1 }, { page: 2, l: 1, t: 2, r: 2, b: 1 }],
    itemRefs: ["#/texts/10", "#/texts/11"],
    flags: [],
    picture: null,
  };
}

function expectRejected(mutate: (response: any) => void, pathFragment: string): void {
  const response = minimalResponse();
  mutate(response);
  let caught: unknown;
  try {
    assertDoclingParseResponse(response);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: "INVALID_DOCLING_RESPONSE", classification: "deterministic" });
  expect((caught as Error).message).toContain(pathFragment);
}

describe("assertDoclingParseResponse", () => {
  test("accepts a minimal hand-written response", () => {
    expect(() => assertDoclingParseResponse(minimalResponse())).not.toThrow();
  });

  test("accepts a multi-page text chunk and an empty heading list", () => {
    const response = minimalResponse();
    response.chunks.push(textChunk(2));
    expect(() => assertDoclingParseResponse(response)).not.toThrow();
  });

  test("accepts picture chunks without a chart outcome and with a raw-text outcome", () => {
    const response = minimalResponse();
    response.chunks[1].flags = ["picture_text_recovered", "chart_multi_series_unparsed"];
    response.chunks[1].picture.pairCount = 0;
    response.diagnostics.flagCounts = { ...response.diagnostics.flagCounts, chart_multi_series_unparsed: 1 };
    delete response.diagnostics.flagCounts.chart_pairs_extracted;
    expect(() => assertDoclingParseResponse(response)).not.toThrow();
  });

  test("rejects non-object bodies", () => {
    for (const body of [null, [], "x", 1]) {
      expect(() => assertDoclingParseResponse(body)).toThrow("response must be an object");
    }
  });

  test("rejects schemaVersion other than 1", () => {
    expectRejected((response) => { response.schemaVersion = 2; }, "schemaVersion");
    expectRejected((response) => { response.schemaVersion = "1"; }, "schemaVersion");
  });

  test("rejects a malformed source.sha256", () => {
    expectRejected((response) => { response.source.sha256 = "A".repeat(64); }, "source.sha256");
    expectRejected((response) => { response.source.sha256 = "a".repeat(63); }, "source.sha256");
    expectRejected((response) => { delete response.source.sha256; }, "source.sha256");
  });

  test("rejects unknown properties at every level", () => {
    expectRejected((response) => { response.extra = true; }, "response contains an unknown property");
    expectRejected((response) => { response.chunks[0].bbox = []; }, "chunks[0] contains an unknown property");
    expectRejected((response) => { response.pages[0].stats.images = 1; }, "pages[0].stats contains an unknown property");
  });

  test("rejects an unknown chunk type", () => {
    expectRejected((response) => { response.chunks[0].type = "list"; }, "chunks[0].type");
  });

  test("rejects an unknown flag", () => {
    expectRejected((response) => { response.chunks[0].flags.push("ocr_applied"); }, "chunks[0].flags[4]");
  });

  test("rejects flags not allowed for the chunk type", () => {
    expectRejected((response) => {
      response.chunks.push({ ...textChunk(2), flags: ["table_span_collapsed"] });
      response.diagnostics.flagCounts.table_span_collapsed = 2;
    }, "chunks[2].flags[0] is not allowed on text chunks");
    expectRejected((response) => {
      response.chunks[0].flags.push("picture_text_recovered");
    }, "chunks[0].flags[4] is not allowed on key_value chunks");
  });

  test("table_cells_fused is a table-only flag", () => {
    expect(DOCLING_FLAGS_BY_CHUNK_TYPE.table).toContain("table_cells_fused");
    expectRejected((response) => {
      response.chunks[0].flags.push("table_cells_fused");
    }, "chunks[0].flags[4] is not allowed on key_value chunks");
  });

  test("rejects duplicate flags and missing required type flags", () => {
    expectRejected((response) => { response.chunks[0].flags.push("ordinal_joined"); }, "chunks[0].flags must be unique");
    expectRejected((response) => {
      response.chunks[0].flags = ["table_span_collapsed", "ordinal_joined", "heading_from_table_title"];
    }, "must include kv_panel_detected");
    expectRejected((response) => {
      response.chunks[1].flags = ["chart_pairs_extracted"];
    }, "must include picture_text_recovered");
  });

  test("rejects more than one picture outcome flag", () => {
    expectRejected((response) => {
      response.chunks[1].flags.push("chart_unpaired");
    }, "at most one picture outcome flag");
  });

  test("rejects a pairCount inconsistent with chart_pairs_extracted", () => {
    expectRejected((response) => { response.chunks[1].picture.pairCount = 0; }, "chunks[1].picture.pairCount");
    expectRejected((response) => {
      response.chunks[1].flags = ["picture_text_recovered", "chart_unpaired"];
    }, "chunks[1].picture.pairCount");
  });

  test("rejects a non-contiguous chunkIndex", () => {
    expectRejected((response) => { response.chunks[1].chunkIndex = 2; }, "chunks[1].chunkIndex");
    expectRejected((response) => { response.chunks[0].chunkIndex = 1; }, "chunks[0].chunkIndex");
  });

  test("rejects an empty chunk list", () => {
    expectRejected((response) => {
      response.chunks = [];
      response.diagnostics.flagCounts = {};
    }, "chunks must not be empty");
  });

  test("rejects a chunk page outside 1..pageCount", () => {
    expectRejected((response) => { response.chunks[1].pages = [3]; }, "chunks[1].pages[0]");
    expectRejected((response) => { response.chunks[0].pages = [0]; }, "chunks[0].pages[0]");
  });

  test("rejects empty, unsorted or duplicated chunk pages", () => {
    expectRejected((response) => { response.chunks[0].pages = []; }, "chunks[0].pages must not be empty");
    expectRejected((response) => { response.chunks[0].pages = [2, 1]; }, "chunks[0].pages must be strictly ascending");
    expectRejected((response) => { response.chunks[0].pages = [1, 1]; }, "chunks[0].pages must be strictly ascending");
  });

  test("rejects a bbox page not in the chunk pages", () => {
    expectRejected((response) => { response.chunks[0].bboxes[0].page = 2; }, "chunks[0].bboxes[0].page");
  });

  test("rejects missing or non-normalized bboxes", () => {
    expectRejected((response) => { response.chunks[0].bboxes = []; }, "chunks[0].bboxes must not be empty");
    expectRejected((response) => {
      response.chunks[0].bboxes[0] = { page: 1, l: 290.4, t: 610.2, r: 20.1, b: 480.7 };
    }, "l < r");
    expectRejected((response) => {
      response.chunks[0].bboxes[0] = { page: 1, l: 20.1, t: 480.7, r: 290.4, b: 610.2 };
    }, "b < t");
    expectRejected((response) => { response.chunks[0].bboxes[0].l = Number.NaN; }, "chunks[0].bboxes[0].l");
  });

  test("rejects empty, untrimmed or NUL-bearing text", () => {
    expectRejected((response) => { response.chunks[0].text = ""; }, "chunks[0].text");
    expectRejected((response) => { response.chunks[0].text = "  "; }, "chunks[0].text");
    expectRejected((response) => { response.chunks[0].text = " Net AUM: ₹4,506.259 Cr."; }, "chunks[0].text");
    expectRejected((response) => { response.chunks[0].text = "Net AUM:\u0000 ₹4,506.259 Cr."; }, "chunks[0].text");
    expectRejected((response) => { response.pages[0].text = "a\u0000b"; }, "pages[0].text");
  });

  test("rejects text that repeats a heading line", () => {
    expectRejected((response) => {
      response.chunks[0].text = `Fund Details\n${response.chunks[0].text}`;
    }, "chunks[0].text must not repeat a heading line");
  });

  test("rejects malformed headings", () => {
    expectRejected((response) => { response.chunks[0].headings = [""]; }, "chunks[0].headings[0]");
    expectRejected((response) => { response.chunks[0].headings = ["Fund\nDetails"]; }, "chunks[0].headings[0]");
  });

  test("rejects picture on a non-picture chunk and null picture on a picture chunk", () => {
    expectRejected((response) => {
      response.chunks[0].picture = { classification: "table", confidence: 0.5, pairCount: 0 };
    }, "chunks[0].picture must be null unless type is picture");
    expectRejected((response) => { response.chunks[1].picture = null; }, "chunks[1].picture must be an object");
  });

  test("rejects malformed picture info", () => {
    expectRejected((response) => { response.chunks[1].picture.confidence = 1.5; }, "chunks[1].picture.confidence");
    expectRejected((response) => { response.chunks[1].picture.classification = "Bar Chart"; }, "chunks[1].picture.classification");
  });

  test("rejects malformed itemRefs", () => {
    expectRejected((response) => { response.chunks[0].itemRefs = []; }, "chunks[0].itemRefs must not be empty");
    expectRejected((response) => { response.chunks[0].itemRefs = ["#/body"]; }, "chunks[0].itemRefs[0]");
    expectRejected((response) => { response.chunks[0].itemRefs = ["#/tables/0", "#/tables/0"]; }, "chunks[0].itemRefs must be unique");
  });

  test("rejects page arrays inconsistent with pageCount and position", () => {
    expectRejected((response) => { response.pageCount = 3; }, "pages length must equal pageCount");
    expectRejected((response) => { response.pages[1].pageNumber = 3; }, "pages[1].pageNumber");
    expectRejected((response) => { response.pageCount = 0; }, "pageCount");
  });

  test("rejects hasTable inconsistent with page stats", () => {
    expectRejected((response) => { response.pages[0].hasTable = false; }, "pages[0].hasTable must equal stats.tables > 0");
    expectRejected((response) => { response.pages[0].stats.tables = -1; }, "pages[0].stats.tables");
  });

  test("rejects producer versions that disagree with parserVersion", () => {
    expectRejected((response) => { response.producer.doclingVersion = "2.133.0"; }, "producer.parserVersion must embed");
    expectRejected((response) => { response.producer.normalizerVersion = "2"; }, "producer.parserVersion must embed");
    expectRejected((response) => { response.producer.pipelineOptionsSha256 = "b".repeat(64); }, "producer.parserVersion must embed");
    expectRejected((response) => { response.producer.parserVersion = "docling-2.132.0"; }, "producer.parserVersion must match");
    expectRejected((response) => { response.producer.serviceVersion = "1.0"; }, "producer.serviceVersion");
  });

  test("rejects diagnostics that disagree with chunk flags", () => {
    expectRejected((response) => { response.diagnostics.flagCounts.ordinal_joined = 4; }, "diagnostics.flagCounts.ordinal_joined");
    expectRejected((response) => { delete response.diagnostics.flagCounts.ordinal_joined; }, "must list every flag");
    expectRejected((response) => { response.diagnostics.flagCounts.ocr_applied = 1; }, "unknown normalization flag");
  });

  test("rejects malformed diagnostics", () => {
    expectRejected((response) => { response.diagnostics.conversionStatus = "partial_success"; }, "diagnostics.conversionStatus");
    expectRejected((response) => { delete response.diagnostics.droppedPictures.qrCode; }, "diagnostics.droppedPictures.qrCode");
    expectRejected((response) => { response.diagnostics.conversionMs = 1.5; }, "diagnostics.conversionMs");
  });

  test("error messages never echo field values", () => {
    expectRejected((response) => { response.chunks[0].type = "/srv/secret/path"; }, "chunks[0].type");
    const response = minimalResponse();
    response.chunks[0].type = "/srv/secret/path";
    expect(() => assertDoclingParseResponse(response)).not.toThrow(/secret/);
  });
});

describe("JSON Schema parity", () => {
  test("chunk types, flags and per-type flag sets match the normative schema", async () => {
    const schema = await Bun.file(SCHEMA_PATH).json();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$defs.chunkType.enum).toEqual([...DOCLING_CHUNK_TYPES]);
    expect(schema.$defs.flag.enum).toEqual([...DOCLING_NORMALIZATION_FLAGS]);

    const branches = schema.$defs.chunk.allOf as any[];
    for (const type of DOCLING_CHUNK_TYPES) {
      const branch = branches.find((candidate) => candidate.if.properties.type.const === type);
      expect(branch.then.properties.flags.items.enum).toEqual([...DOCLING_FLAGS_BY_CHUNK_TYPE[type]]);
    }
  });

  test("every object in the schema forbids additional properties", async () => {
    const schema = await Bun.file(SCHEMA_PATH).json();
    const objects: any[] = [schema, ...Object.values(schema.$defs as Record<string, any>)]
      .flatMap(function collect(node: any): any[] {
        if (!node || typeof node !== "object") return [];
        const children = Object.values(node).flatMap(collect);
        return node.type === "object" ? [node, ...children] : children;
      });
    const open = objects.filter((node) => node.additionalProperties !== false && !node.propertyNames);
    expect(open).toEqual([]);
  });
});
