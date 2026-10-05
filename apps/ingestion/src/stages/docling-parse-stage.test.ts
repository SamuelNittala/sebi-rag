import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ArtifactDescriptor } from "@mf-rag/types";

import type { DoclingParseRequestOptions } from "../parsers/docling-client.ts";
import type { DoclingParseResponse } from "../parsers/docling-contract.ts";
import { minimalDoclingResponse, TEST_DOCLING_PARSER_VERSION } from "../parsers/docling-test-fixture.ts";
import {
  DoclingParseStage,
  decodeDoclingParseArtifact,
  doclingPdfMediaType,
  encodeDoclingParseArtifact,
  type DoclingPdfParseArtifact,
} from "./docling-parse-stage.ts";
import { parsedPdfMediaType, type PdfStageArtifactStore } from "./parse-pdf-stage.ts";

const rawBytes = new TextEncoder().encode("%PDF-1.7\ndocling stage fixture");
const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");

class MemoryArtifactStore implements PdfStageArtifactStore {
  readonly outputs = new Map<string, { bytes: Uint8Array; mediaType: string; producerVersion: string }>();

  constructor(private readonly raw: Uint8Array) {}

  async readVerified(): Promise<Uint8Array> {
    return this.raw;
  }

  async put(input: {
    namespace: string;
    bytes: Uint8Array;
    sha256: string;
    byteSize: number;
    mediaType: string;
    producerVersion: string;
  }): Promise<ArtifactDescriptor> {
    this.outputs.set(input.sha256, input);
    return {
      key: `${input.namespace}/${input.sha256}`,
      uri: `memory://${input.sha256}`,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      producerVersion: input.producerVersion,
    };
  }
}

function rawArtifact(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    key: "raw/fixture",
    uri: "file:///var/lib/worker-a/raw/fixture",
    sha256: rawSha256,
    byteSize: rawBytes.byteLength,
    mediaType: "application/pdf",
    producerVersion: "fetch-v1",
    ...overrides,
  };
}

function response(mutate: (body: any) => void = () => {}): DoclingParseResponse {
  const body: any = structuredClone(minimalDoclingResponse({ sha256: rawSha256, byteSize: rawBytes.byteLength }));
  mutate(body);
  return body;
}

type ParseFn = (bytes: Uint8Array, options: DoclingParseRequestOptions) => Promise<DoclingParseResponse>;

function createStage(
  store: MemoryArtifactStore,
  parse: ParseFn = async () => response(),
  limits: { deadlineMs?: number; maxPages?: number; maxTextChars?: number } = {},
): DoclingParseStage {
  return new DoclingParseStage({ artifactStore: store, parse }, {
    serviceUrl: "http://docling:8090",
    parserVersion: TEST_DOCLING_PARSER_VERSION,
    producerVersion: `parse-artifact-v1+${TEST_DOCLING_PARSER_VERSION}`,
    maxResponseBytes: 1_000_000,
    ...limits,
  });
}

const input = (overrides: Partial<Parameters<DoclingParseStage["execute"]>[0]> = {}) => ({
  documentVersionId: "version-1",
  rawArtifact: rawArtifact(),
  filename: "factsheet.pdf",
  canonicalUrl: "https://example.com/docs/factsheet.pdf#page=2",
  ...overrides,
});

describe("DoclingParseStage", () => {
  test("stores a Docling artifact with its media type and producer version", async () => {
    const store = new MemoryArtifactStore(rawBytes);
    const calls: { bytes: Uint8Array; options: DoclingParseRequestOptions }[] = [];
    const result = await createStage(store, async (bytes, options) => {
      calls.push({ bytes, options });
      return response();
    }).execute(input());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.bytes).toEqual(rawBytes);
    expect(calls[0]!.options).toMatchObject({
      baseUrl: "http://docling:8090",
      expectedParserVersion: TEST_DOCLING_PARSER_VERSION,
      maxResponseBytes: 1_000_000,
    });
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
    expect(result.artifact.mediaType).toBe(doclingPdfMediaType());
    expect(doclingPdfMediaType()).toBe("application/vnd.mf-rag.docling-pdf+json;version=1");
    expect(doclingPdfMediaType()).not.toBe(parsedPdfMediaType());
    expect(result.artifact.producerVersion).toBe(`parse-artifact-v1+${TEST_DOCLING_PARSER_VERSION}`);
    expect(result.parsed).toMatchObject({
      schemaVersion: 1,
      documentVersionId: "version-1",
      source: {
        filename: "factsheet.pdf",
        canonicalUrl: "https://example.com/docs/factsheet.pdf",
        rawSha256,
        rawByteSize: rawBytes.byteLength,
      },
      parser: {
        kind: "docling",
        parserVersion: TEST_DOCLING_PARSER_VERSION,
        tableExtractorVersion: "docling-tableformer-accurate+norm-1",
      },
      diagnostics: {
        pageCount: 2,
        emptyPageCount: 1,
        tableCount: 1,
        pictureChunkCount: 1,
        flagCounts: { kv_panel_detected: 1, picture_text_recovered: 1, chart_pairs_extracted: 1 },
        droppedPictures: { logo: 2, signature: 0, stamp: 0, qrCode: 0, barCode: 0, noText: 0 },
      },
    });
    expect(result.parsed.pages[0]).toEqual({
      pageNumber: 1,
      text: "MIRAE ASSET FLEXI CAP FUND\nDate of Inception/ Allotment: 24th February 2023",
      hasTable: true,
      stats: { textItems: 2, tables: 1, pictures: 0, pictureTextChars: 0, bodyTextChars: 80 },
    });
    expect(result.parsed.chunks).toEqual(response().chunks);
    const stored = store.outputs.get(result.artifact.sha256)!;
    expect(decodeDoclingParseArtifact(stored.bytes)).toEqual(result.parsed);
  });

  test("sends the source's fundNamePrefixes to the Docling service and omits them when undeclared", async () => {
    const seen: DoclingParseRequestOptions[] = [];
    const capture: ParseFn = async (_bytes, options) => { seen.push(options); return response(); };

    await createStage(new MemoryArtifactStore(rawBytes), capture).execute(input({ fundNamePrefixes: ["Mirae Asset"] }));
    await createStage(new MemoryArtifactStore(rawBytes), capture).execute(input());

    expect(seen[0]!.fundNamePrefixes).toEqual(["Mirae Asset"]);
    expect(Object.hasOwn(seen[1]!, "fundNamePrefixes")).toBe(false);
  });

  test("is stable across raw artifact locations, conversion times and workers, and leaks no local paths", async () => {
    const first = await createStage(new MemoryArtifactStore(rawBytes)).execute(input());
    const second = await createStage(
      new MemoryArtifactStore(rawBytes),
      async () => response((body) => { body.diagnostics.conversionMs = 99_999; }),
    ).execute(input({
      rawArtifact: rawArtifact({ key: "raw/other", uri: "s3://other-host/raw/other" }),
      canonicalUrl: "https://example.com/docs/factsheet.pdf",
    }));

    expect(first.artifact.sha256).toBe(second.artifact.sha256);
    const serialized = JSON.stringify(first.parsed);
    expect(serialized).not.toContain("/var/lib/worker-a");
    expect(serialized).not.toContain("raw/fixture");
    expect(serialized).not.toContain("conversionMs");
  });

  test("rejects a non-PDF raw artifact before reading it", async () => {
    let parsed = false;
    await expect(createStage(new MemoryArtifactStore(rawBytes), async () => {
      parsed = true;
      return response();
    }).execute(input({ rawArtifact: rawArtifact({ mediaType: "text/html" }) })))
      .rejects.toMatchObject({ code: "INVALID_RAW_MEDIA_TYPE", classification: "deterministic" });
    expect(parsed).toBe(false);
  });

  test("rejects raw bytes that do not match their descriptor", async () => {
    await expect(createStage(new MemoryArtifactStore(new TextEncoder().encode("tampered"))).execute(input()))
      .rejects.toMatchObject({ code: "RAW_ARTIFACT_CHECKSUM_MISMATCH", classification: "deterministic" });
  });

  test("maps the Docling deadline to PARSE_DEADLINE_EXCEEDED but propagates caller aborts", async () => {
    const hang: ParseFn = (_bytes, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    await expect(createStage(new MemoryArtifactStore(rawBytes), hang, { deadlineMs: 10 }).execute(input()))
      .rejects.toMatchObject({ code: "PARSE_DEADLINE_EXCEEDED", classification: "deterministic" });

    const controller = new AbortController();
    const reason = new Error("worker shutting down");
    setTimeout(() => controller.abort(reason), 5);
    await expect(createStage(new MemoryArtifactStore(rawBytes), hang, { deadlineMs: 60_000 })
      .execute(input({ signal: controller.signal }))).rejects.toBe(reason);
  });

  test("enforces page and text limits on the service response", async () => {
    await expect(createStage(new MemoryArtifactStore(rawBytes), undefined, { maxPages: 1 }).execute(input()))
      .rejects.toMatchObject({ code: "PDF_PAGE_LIMIT_EXCEEDED", classification: "deterministic" });
    await expect(createStage(new MemoryArtifactStore(rawBytes), undefined, { maxTextChars: 20 }).execute(input()))
      .rejects.toMatchObject({ code: "PDF_TEXT_LIMIT_EXCEEDED", classification: "deterministic" });
  });

  test("passes client errors through unchanged", async () => {
    const failure = Object.assign(new Error("Docling service is unreachable."), {
      code: "DOCLING_SERVICE_UNAVAILABLE",
      classification: "transient",
    });
    await expect(createStage(new MemoryArtifactStore(rawBytes), async () => { throw failure; }).execute(input()))
      .rejects.toBe(failure);
  });
});

describe("Docling parse artifact codec", () => {
  async function artifact(): Promise<DoclingPdfParseArtifact> {
    return (await createStage(new MemoryArtifactStore(rawBytes)).execute(input())).parsed;
  }

  test("round-trips through encode and decode", async () => {
    const parsed = await artifact();
    expect(decodeDoclingParseArtifact(encodeDoclingParseArtifact(parsed))).toEqual(parsed);
  });

  test.each([
    ["invalid JSON", () => new TextEncoder().encode("{")],
    ["an unpdf artifact shape", async () => {
      const { parser: _parser, chunks: _chunks, ...rest } = await artifact();
      return encode({ ...rest, parser: { parserVersion: "unpdf", tableExtractorVersion: "pdfplumber" }, tables: [] });
    }],
    ["a wrong parser kind", async () => encode(mutate(await artifact(), (value) => { value.parser.kind = "unpdf"; }))],
    ["an unknown root property", async () => encode(mutate(await artifact(), (value) => { value.localPath = "/tmp/x"; }))],
    ["a page out of order", async () => encode(mutate(await artifact(), (value) => { value.pages[1].pageNumber = 3; }))],
    ["hasTable disagreeing with stats", async () => encode(mutate(await artifact(), (value) => { value.pages[0].hasTable = false; }))],
    ["a chunk outside the page range", async () => encode(mutate(await artifact(), (value) => { value.chunks[0].pages = [5]; }))],
    ["a tampered chunk flag", async () => encode(mutate(await artifact(), (value) => { value.chunks[0].flags = []; }))],
    ["empty chunks", async () => encode(mutate(await artifact(), (value) => { value.chunks = []; }))],
    ["tampered diagnostics", async () => encode(mutate(await artifact(), (value) => { value.diagnostics.tableCount = 7; }))],
    ["tampered flag counts", async () => encode(mutate(await artifact(), (value) => { value.diagnostics.flagCounts.kv_panel_detected = 2; }))],
    ["a bad source checksum", async () => encode(mutate(await artifact(), (value) => { value.source.rawSha256 = "nope"; }))],
  ])("rejects %s", async (_name, build) => {
    const bytes = await build();
    let caught: unknown;
    try {
      decodeDoclingParseArtifact(bytes);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "INVALID_PARSED_ARTIFACT", classification: "deterministic" });
  });
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function mutate(value: DoclingPdfParseArtifact, change: (value: any) => void): unknown {
  const copy: any = structuredClone(value);
  change(copy);
  return copy;
}
