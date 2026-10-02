import type { DoclingParseResponse } from "./docling-contract.ts";

/** Test-only: smallest response that satisfies the v1 contract for the given source bytes. */
export const TEST_DOCLING_PARSER_VERSION = "docling-2.132.0+norm-1+opts-3f9a1c2b7d10";

export function minimalDoclingResponse(source: { sha256: string; byteSize: number }): DoclingParseResponse {
  return {
    schemaVersion: 1,
    producer: {
      parserVersion: TEST_DOCLING_PARSER_VERSION,
      serviceVersion: "1.0.0",
      doclingVersion: "2.132.0",
      doclingCoreVersion: "2.99.0",
      doclingIbmModelsVersion: "4.0.3",
      normalizerVersion: "1",
      pipelineOptionsSha256: "3f9a1c2b7d10".padEnd(64, "0"),
    },
    source,
    pageCount: 2,
    pages: [
      {
        pageNumber: 1,
        width: 595,
        height: 842,
        text: "MIRAE ASSET FLEXI CAP FUND\nDate of Inception/ Allotment: 24th February 2023",
        hasTable: true,
        stats: { textItems: 2, tables: 1, pictures: 0, pictureTextChars: 0, bodyTextChars: 80 },
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
        text: "Date of Inception/ Allotment: 24th February 2023",
        headings: ["Fund Details"],
        pages: [1],
        bboxes: [{ page: 1, l: 20.1, t: 610.2, r: 290.4, b: 480.7 }],
        itemRefs: ["#/tables/0"],
        flags: ["kv_panel_detected"],
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
      flagCounts: { kv_panel_detected: 1, picture_text_recovered: 1, chart_pairs_extracted: 1 },
      conversionStatus: "success",
      conversionMs: 1200,
    },
  };
}
