import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ArtifactDescriptor } from "@mf-rag/types";

import {
  ParsePdfStage,
  decodeNormalizedParseArtifact,
  type PdfStageArtifactStore,
} from "./parse-pdf-stage.ts";

const rawBytes = new TextEncoder().encode("%PDF-1.7\nfixture");
const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");

class MemoryArtifactStore implements PdfStageArtifactStore {
  readonly outputs = new Map<string, Uint8Array>();

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
    this.outputs.set(input.sha256, input.bytes);
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
    uri: "memory://worker-a/raw/fixture",
    sha256: rawSha256,
    byteSize: rawBytes.byteLength,
    mediaType: "application/pdf",
    producerVersion: "fetch-v1",
    ...overrides,
  };
}

function createStage(store: MemoryArtifactStore, paths: string[] = []): ParsePdfStage {
  return new ParsePdfStage({
    artifactStore: store,
    parseFile: async (path) => {
      paths.push(path);
      return {
        filename: "ignored-local-name.pdf",
        filepath: path,
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: "Official product overview", hasTable: false },
          { pageNumber: 2, text: "Minimum Amount 100", hasTable: true },
        ],
        rawText: "Official product overview\nMinimum Amount 100",
      };
    },
    extractTablesFromFile: async () => ({
      tables: [{
        page: 2,
        tableIndex: 0,
        rows: [["Minimum Amount", "100"]],
        markdown: "| Minimum Amount | 100 |",
      }],
    }),
  }, {
    parserVersion: "unpdf-v1",
    tableExtractorVersion: "pdfplumber-v1",
    producerVersion: "parse-stage-v1",
  });
}

describe("ParsePdfStage", () => {
  test("produces one stable normalized artifact independent of worker-local path and raw URI", async () => {
    const firstStore = new MemoryArtifactStore(rawBytes);
    const secondStore = new MemoryArtifactStore(rawBytes);
    const firstPaths: string[] = [];
    const secondPaths: string[] = [];

    const first = await createStage(firstStore, firstPaths).execute({
      documentVersionId: "version-1",
      rawArtifact: rawArtifact(),
      filename: "factsheet.pdf",
      canonicalUrl: "https://example.com/docs/factsheet.pdf#download",
    });
    const second = await createStage(secondStore, secondPaths).execute({
      documentVersionId: "version-1",
      rawArtifact: rawArtifact({ key: "raw/other-key", uri: "s3://other-host/raw" }),
      filename: "factsheet.pdf",
      canonicalUrl: "https://example.com/docs/factsheet.pdf",
    });

    expect(first.artifact.sha256).toBe(second.artifact.sha256);
    expect(firstPaths[0]).not.toBe(secondPaths[0]);
    expect(first.parsed).toEqual(second.parsed);
    expect(first.parsed).toMatchObject({
      documentVersionId: "version-1",
      source: { filename: "factsheet.pdf", rawSha256 },
      diagnostics: { pageCount: 2, tableCount: 1 },
    });
    expect(JSON.stringify(first.parsed)).not.toContain(firstPaths[0]!);
    expect(decodeNormalizedParseArtifact(firstStore.outputs.get(first.artifact.sha256)!)).toEqual(first.parsed);
  });

  test("normalizes host-specific table extractor errors without changing the artifact checksum", async () => {
    const run = async (error: string) => {
      const store = new MemoryArtifactStore(rawBytes);
      const stage = new ParsePdfStage({
        artifactStore: store,
        parseFile: async (path) => ({
          filename: "fixture.pdf",
          filepath: path,
          pageCount: 1,
          pages: [{ pageNumber: 1, text: "usable text", hasTable: false }],
          rawText: "usable text",
        }),
        extractTablesFromFile: async () => ({ tables: [], error }),
      }, {
        parserVersion: "unpdf-v1",
        tableExtractorVersion: "pdfplumber-v1",
        producerVersion: "parse-stage-v1",
      });
      return stage.execute({
        documentVersionId: "version-1",
        rawArtifact: rawArtifact(),
        filename: "fixture.pdf",
        canonicalUrl: "https://example.com/fixture.pdf",
      });
    };

    const workerA = await run("python failed reading /tmp/worker-a/fixture.pdf");
    const workerB = await run("python failed reading /different/host/worker-b/fixture.pdf");
    expect(workerA.artifact.sha256).toBe(workerB.artifact.sha256);
    expect(workerA.parsed.diagnostics).toMatchObject({
      tableExtractionStatus: "failed",
      tableExtractionCode: "TABLE_EXTRACTION_FAILED",
    });
    expect(JSON.stringify(workerA.parsed)).not.toContain("/tmp/worker-a");
  });

  test("fails deterministically when artifact integrity or parsed content is invalid", async () => {
    const corruptStore = new MemoryArtifactStore(new TextEncoder().encode("different"));
    await expect(createStage(corruptStore).execute({
      documentVersionId: "version-1",
      rawArtifact: rawArtifact(),
      filename: "factsheet.pdf",
      canonicalUrl: "https://example.com/factsheet.pdf",
    })).rejects.toMatchObject({ code: "RAW_ARTIFACT_CHECKSUM_MISMATCH", classification: "deterministic" });

    const store = new MemoryArtifactStore(rawBytes);
    const stage = new ParsePdfStage({
      artifactStore: store,
      parseFile: async (path) => ({ filename: "empty.pdf", filepath: path, pageCount: 1, pages: [
        { pageNumber: 1, text: "", hasTable: false },
      ], rawText: "" }),
      extractTablesFromFile: async () => ({ tables: [] }),
    }, {
      parserVersion: "unpdf-v1",
      tableExtractorVersion: "pdfplumber-v1",
      producerVersion: "parse-stage-v1",
    });
    await expect(stage.execute({
      documentVersionId: "version-1",
      rawArtifact: rawArtifact(),
      filename: "empty.pdf",
      canonicalUrl: "https://example.com/empty.pdf",
    })).rejects.toMatchObject({ code: "EMPTY_PARSED_CONTENT", classification: "deterministic" });
  });
});
