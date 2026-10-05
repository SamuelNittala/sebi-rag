import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ArtifactDescriptor } from "@mf-rag/types";
import type { Database } from "@mf-rag/db/client";
import type { ReviewRunSourceLineage } from "@mf-rag/db/review-queries";

import { parsedPdfMediaType } from "../../../../ingestion/src/stages/parse-pdf-stage.ts";
import { doclingPdfMediaType } from "../../../../ingestion/src/stages/docling-parse-stage.ts";
import { sha256Hex } from "../../../../pipeline/src/artifacts/artifact-store.ts";
import {
  ReviewSourceArtifacts,
  ReviewSourceError,
  resolveSourceLineage,
  type DoclingSourceLineage,
} from "./source-artifacts.ts";
import {
  createFixtureRoot,
  createStoredDoclingFixture,
  DOCLING_GOLDENS,
  removeFixtureRoot,
  type StoredDoclingFixture,
} from "./test-fixtures.ts";

/** These tests never touch the database; `resolve(runId)` is covered by the route integration suite. */
const NO_DB = new Proxy({}, {
  get() {
    throw new Error("database must not be used");
  },
}) as Database;

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_RUN_ID = "33333333-3333-4333-8333-333333333333";

function rawDescriptor(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    key: "raw/v/aa/aa",
    uri: "file:///artifacts/raw/v/aa/aa",
    sha256: "a".repeat(64),
    byteSize: 100,
    mediaType: "application/pdf",
    producerVersion: "fetch-v1",
    ...overrides,
  };
}

function parseDescriptor(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    key: "parsed/v/bb/bb",
    uri: "file:///artifacts/parsed/v/bb/bb",
    sha256: "b".repeat(64),
    byteSize: 200,
    mediaType: doclingPdfMediaType(),
    producerVersion: "parse-artifact-v1",
    ...overrides,
  };
}

function lineageRow(overrides: {
  run?: Partial<ReviewRunSourceLineage["run"]>;
  pipelineRunDocumentVersionId?: string | null;
  rawArtifact?: ArtifactDescriptor | null;
  parseOutputRef?: string | null;
} = {}): ReviewRunSourceLineage {
  return {
    run: {
      id: RUN_ID,
      sourceName: "factsheet.pdf",
      parserVersion: "docling-2.132.0+norm-9",
      documentVersionId: VERSION_ID,
      pipelineRunId: PIPELINE_RUN_ID,
      ...overrides.run,
    } as ReviewRunSourceLineage["run"],
    pipelineRunDocumentVersionId: overrides.pipelineRunDocumentVersionId === undefined
      ? VERSION_ID
      : overrides.pipelineRunDocumentVersionId,
    rawArtifact: overrides.rawArtifact === undefined ? rawDescriptor() : overrides.rawArtifact,
    parseOutputRef: overrides.parseOutputRef === undefined
      ? JSON.stringify(parseDescriptor())
      : overrides.parseOutputRef,
  };
}

function lineageFor(fixture: StoredDoclingFixture, overrides: Partial<DoclingSourceLineage> = {}): DoclingSourceLineage {
  return {
    kind: "docling",
    runId: RUN_ID,
    documentVersionId: fixture.documentVersionId,
    pipelineRunId: PIPELINE_RUN_ID,
    sourceName: "factsheet.pdf",
    parserVersion: fixture.parsed.parser.parserVersion,
    rawArtifact: fixture.rawArtifact,
    parseArtifact: fixture.parseArtifact,
    ...overrides,
  };
}

/** Wraps a store and counts reads per artifact key. */
function countingStore(fixture: StoredDoclingFixture, options: { failFirst?: boolean } = {}) {
  const reads: string[] = [];
  let failNext = options.failFirst ?? false;
  return {
    reads,
    async readVerified(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
      reads.push(descriptor.key);
      await Bun.sleep(5);
      if (failNext) {
        failNext = false;
        throw new Error("transient store failure");
      }
      return fixture.store.readVerified(descriptor);
    },
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReviewSourceError);
  expect((error as ReviewSourceError).code).toBe(code as ReviewSourceError["code"]);
}

describe("resolveSourceLineage", () => {
  test("an unknown run is not_found", () => {
    expect(resolveSourceLineage(undefined)).toEqual({ kind: "not_found" });
  });

  test("a run without document version or pipeline run is a legacy run", () => {
    for (const run of [{ documentVersionId: null }, { pipelineRunId: null }]) {
      expect(resolveSourceLineage(lineageRow({ run, pipelineRunDocumentVersionId: null }))).toEqual({
        kind: "no_lineage",
        reason: "legacy_run",
        parserVersion: "docling-2.132.0+norm-9",
      });
    }
    expect(resolveSourceLineage(lineageRow({ rawArtifact: null }))).toMatchObject({ kind: "no_lineage", reason: "legacy_run" });
  });

  test("a pipeline run of another document version (or a missing one) is LINEAGE_MISMATCH", () => {
    expect(resolveSourceLineage(lineageRow({ pipelineRunDocumentVersionId: "44444444-4444-4444-8444-444444444444" })))
      .toEqual({ kind: "error", code: "LINEAGE_MISMATCH" });
    expect(resolveSourceLineage(lineageRow({ pipelineRunDocumentVersionId: null })))
      .toEqual({ kind: "error", code: "LINEAGE_MISMATCH" });
  });

  test("no usable PARSE output is no_lineage (parse_output_missing)", () => {
    expect(resolveSourceLineage(lineageRow({ parseOutputRef: null }))).toEqual({
      kind: "no_lineage",
      reason: "parse_output_missing",
      parserVersion: "docling-2.132.0+norm-9",
    });
  });

  test("an unreadable output reference is INVALID_ARTIFACT_REFERENCE", () => {
    for (const parseOutputRef of ["not json", JSON.stringify({ key: "parsed/x" }), "review:abc"]) {
      expect(resolveSourceLineage(lineageRow({ parseOutputRef }))).toEqual({ kind: "error", code: "INVALID_ARTIFACT_REFERENCE" });
    }
  });

  test("an unpdf parse artifact is not_docling", () => {
    const row = lineageRow({
      run: { parserVersion: "unpdf-1.0+pdfplumber" },
      parseOutputRef: JSON.stringify(parseDescriptor({ mediaType: parsedPdfMediaType() })),
    });

    expect(resolveSourceLineage(row)).toEqual({
      kind: "not_docling",
      parserVersion: "unpdf-1.0+pdfplumber",
      mediaType: parsedPdfMediaType(),
    });
  });

  test("a raw artifact that is not a PDF is RAW_NOT_PDF", () => {
    expect(resolveSourceLineage(lineageRow({ rawArtifact: rawDescriptor({ mediaType: "text/html" }) })))
      .toEqual({ kind: "error", code: "RAW_NOT_PDF" });
  });

  test("a Docling pipeline run resolves to both descriptors from the run row", () => {
    expect(resolveSourceLineage(lineageRow())).toEqual({
      kind: "docling",
      runId: RUN_ID,
      documentVersionId: VERSION_ID,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceName: "factsheet.pdf",
      parserVersion: "docling-2.132.0+norm-9",
      rawArtifact: rawDescriptor(),
      parseArtifact: parseDescriptor(),
    });
  });
});

describe("ReviewSourceArtifacts", () => {
  let root = "";
  let flexi: StoredDoclingFixture;
  let factsheet: StoredDoclingFixture;

  beforeAll(async () => {
    root = await createFixtureRoot();
    flexi = await createStoredDoclingFixture("mirae-flexi-cap-p34-35", { root });
    factsheet = await createStoredDoclingFixture("mirae-fund-facts-p10", { root });
  });

  afterAll(async () => {
    await removeFixtureRoot(root);
  });

  test("rejects a non-positive cache size", () => {
    expect(() => new ReviewSourceArtifacts(NO_DB, flexi.store, { cacheEntries: 0 })).toThrow();
  });

  test("loads the stored Docling artifact with per-page wire chunks", async () => {
    const sources = new ReviewSourceArtifacts(NO_DB, flexi.store);

    const loaded = await sources.loadDoclingArtifact(lineageFor(flexi));

    expect(loaded.sha256).toBe(flexi.parseArtifact.sha256);
    expect(loaded.pageCount).toBe(2);
    expect(loaded.artifact).toEqual(flexi.parsed);
    expect(loaded.chunksOnPage(1).map((chunk) => chunk.chunkIndex)).toEqual(Array.from({ length: 17 }, (_, index) => index));
    expect(loaded.chunksOnPage(2).map((chunk) => chunk.chunkIndex)).toEqual([17, 18, 19, 20, 21, 22, 23, 24]);
    expect(loaded.chunksOnPage(3)).toEqual([]);
  });

  test("an artifact of another document version is ARTIFACT_VERSION_MISMATCH", async () => {
    const sources = new ReviewSourceArtifacts(NO_DB, flexi.store);

    await expectCode(
      sources.loadDoclingArtifact(lineageFor(flexi, { documentVersionId: crypto.randomUUID() })),
      "ARTIFACT_VERSION_MISMATCH",
    );
  });

  test("an artifact parsed from another raw PDF is RAW_SHA_MISMATCH, also when served from cache", async () => {
    const sources = new ReviewSourceArtifacts(NO_DB, flexi.store);
    await sources.loadDoclingArtifact(lineageFor(flexi));

    await expectCode(
      sources.loadDoclingArtifact(lineageFor(flexi, { rawArtifact: factsheet.rawArtifact })),
      "RAW_SHA_MISMATCH",
    );
  });

  test("tampered artifact bytes are ARTIFACT_READ_FAILED and a missing object too", async () => {
    const tampered = await createStoredDoclingFixture("mirae-fund-performance-p98", { root });
    const path = join(tampered.root, tampered.parseArtifact.key);
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    bytes[10] = bytes[10] === 0x20 ? 0x21 : 0x20;
    await Bun.write(path, bytes);
    const sources = new ReviewSourceArtifacts(NO_DB, tampered.store);

    await expectCode(sources.loadDoclingArtifact(lineageFor(tampered)), "ARTIFACT_READ_FAILED");
    await expectCode(
      sources.loadDoclingArtifact(lineageFor(tampered, {
        parseArtifact: { ...tampered.parseArtifact, key: `parsed/missing/${"c".repeat(64)}` },
      })),
      "ARTIFACT_READ_FAILED",
    );
  });

  test("bytes that verify but are not a Docling artifact are INVALID_PARSED_ARTIFACT", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, pages: [] }));
    const bogus = await flexi.store.put({
      namespace: `parsed/${flexi.documentVersionId}`,
      bytes,
      sha256: sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: doclingPdfMediaType(),
      producerVersion: "parse-test",
    });
    const sources = new ReviewSourceArtifacts(NO_DB, flexi.store);

    await expectCode(sources.loadDoclingArtifact(lineageFor(flexi, { parseArtifact: bogus })), "INVALID_PARSED_ARTIFACT");
  });

  test("a second load is served from the cache", async () => {
    const store = countingStore(flexi);
    const sources = new ReviewSourceArtifacts(NO_DB, store);

    const first = await sources.loadDoclingArtifact(lineageFor(flexi));
    const second = await sources.loadDoclingArtifact(lineageFor(flexi));

    expect(second).toBe(first);
    expect(store.reads).toHaveLength(1);
  });

  test("concurrent loads share one store read", async () => {
    const store = countingStore(flexi);
    const sources = new ReviewSourceArtifacts(NO_DB, store);

    const loaded = await Promise.all(Array.from({ length: 5 }, () => sources.loadDoclingArtifact(lineageFor(flexi))));

    expect(new Set(loaded).size).toBe(1);
    expect(store.reads).toHaveLength(1);
  });

  test("a failed load is not cached", async () => {
    const store = countingStore(flexi, { failFirst: true });
    const sources = new ReviewSourceArtifacts(NO_DB, store);

    await expectCode(sources.loadDoclingArtifact(lineageFor(flexi)), "ARTIFACT_READ_FAILED");
    const loaded = await sources.loadDoclingArtifact(lineageFor(flexi));

    expect(loaded.pageCount).toBe(2);
    expect(store.reads).toHaveLength(2);
  });

  test("keeps at most 4 decoded artifacts and evicts the least recently used", async () => {
    const lruRoot = await createFixtureRoot();
    try {
      const fixtures = await Promise.all(DOCLING_GOLDENS.slice(0, 5)
        .map((name) => createStoredDoclingFixture(name, { root: lruRoot })));
      const store = countingStore(fixtures[0]!);
      const sources = new ReviewSourceArtifacts(NO_DB, store);
      const load = (index: number) => sources.loadDoclingArtifact(lineageFor(fixtures[index]!));

      for (const index of [0, 1, 2, 3]) await load(index);
      await load(0); // 0 becomes most recent; 1 is now least recent
      expect(store.reads).toHaveLength(4);

      await load(4); // evicts 1
      await load(0);
      await load(2);
      await load(3);
      await load(4);
      expect(store.reads).toHaveLength(5);

      await load(1);
      expect(store.reads).toHaveLength(6);
      expect(store.reads.at(-1)).toBe(fixtures[1]!.parseArtifact.key);
    } finally {
      await removeFixtureRoot(lruRoot);
    }
  });

  test("loadRawPdf returns the verified PDF bytes and is not cached", async () => {
    const store = countingStore(flexi);
    const sources = new ReviewSourceArtifacts(NO_DB, store);

    expect(await sources.loadRawPdf(lineageFor(flexi))).toEqual(flexi.pdfBytes);
    await sources.loadRawPdf(lineageFor(flexi));
    expect(store.reads).toEqual([flexi.rawArtifact.key, flexi.rawArtifact.key]);
  });

  test("loadRawPdf maps store failures to ARTIFACT_READ_FAILED", async () => {
    const sources = new ReviewSourceArtifacts(NO_DB, flexi.store);

    await expectCode(
      sources.loadRawPdf(lineageFor(flexi, { rawArtifact: { ...flexi.rawArtifact, sha256: "0".repeat(64) } })),
      "ARTIFACT_READ_FAILED",
    );
  });
});
