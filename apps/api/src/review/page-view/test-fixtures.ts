/**
 * Test-only helper: builds a real stored Docling parse artifact from the
 * committed goldens (`tests/fixtures/docling/<name>.pdf` + `<name>.wire.json`).
 * The PDF goes into a `FilesystemArtifactStore` as the raw artifact and
 * `DoclingParseStage.execute` runs with the golden wire response in place of
 * the docling service, so the stored bytes and descriptor are exactly what the
 * pipeline writes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactDescriptor } from "@mf-rag/types";

import { FilesystemArtifactStore } from "../../../../pipeline/src/artifacts/filesystem-artifact-store.ts";
import { sha256Hex } from "../../../../pipeline/src/artifacts/artifact-store.ts";
import type { DoclingParseResponse } from "../../../../ingestion/src/parsers/docling-contract.ts";
import { DoclingParseStage, type DoclingPdfParseArtifact } from "../../../../ingestion/src/stages/docling-parse-stage.ts";

export const DOCLING_GOLDENS = [
  "mirae-flexi-cap-p34-35",
  "mirae-fund-facts-p10",
  "mirae-fund-performance-p88",
  "mirae-fund-performance-p98",
  "mirae-passive-etf-p34",
  "mirae-passive-offerings-p9",
  "mirae-sip-performance-p103",
  "mirae-sip-performance-p104",
] as const;
export type DoclingGolden = (typeof DOCLING_GOLDENS)[number];

const GOLDEN_DIR = new URL("../../../../../tests/fixtures/docling/", import.meta.url);

export interface StoredDoclingFixture {
  readonly root: string;
  readonly store: FilesystemArtifactStore;
  readonly documentVersionId: string;
  readonly pdfBytes: Uint8Array;
  readonly wire: DoclingParseResponse;
  readonly rawArtifact: ArtifactDescriptor;
  readonly parseArtifact: ArtifactDescriptor;
  readonly parsed: DoclingPdfParseArtifact;
}

export interface StoredDoclingFixtureOptions {
  /** Store root; defaults to a fresh temp dir (remove it with `removeFixtureRoot`). */
  readonly root?: string;
  /** Distinct ids give distinct parse artifacts (different sha256) for the same golden. */
  readonly documentVersionId?: string;
}

export async function createFixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "review-page-view-"));
}

export async function removeFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function goldenWire(name: DoclingGolden): Promise<DoclingParseResponse> {
  return await Bun.file(new URL(`${name}.wire.json`, GOLDEN_DIR)).json();
}

export async function createStoredDoclingFixture(
  name: DoclingGolden,
  options: StoredDoclingFixtureOptions = {},
): Promise<StoredDoclingFixture> {
  const root = options.root ?? await createFixtureRoot();
  const documentVersionId = options.documentVersionId ?? crypto.randomUUID();
  const store = new FilesystemArtifactStore(root);
  const pdfBytes = new Uint8Array(await Bun.file(new URL(`${name}.pdf`, GOLDEN_DIR)).arrayBuffer());
  const wire = await goldenWire(name);
  const rawArtifact = await store.put({
    namespace: `raw/${documentVersionId}`,
    bytes: pdfBytes,
    sha256: sha256Hex(pdfBytes),
    byteSize: pdfBytes.byteLength,
    mediaType: "application/pdf",
    producerVersion: "fetch-test",
  });
  const stage = new DoclingParseStage({ artifactStore: store, parse: async () => wire }, {
    serviceUrl: "http://docling:8090",
    parserVersion: wire.producer.parserVersion,
    producerVersion: `parse-artifact-v1+${wire.producer.parserVersion}`,
  });
  const { artifact, parsed } = await stage.execute({
    documentVersionId,
    rawArtifact,
    filename: `${name}.pdf`,
    canonicalUrl: `https://example.com/factsheets/${name}.pdf`,
  });
  return { root, store, documentVersionId, pdfBytes, wire, rawArtifact, parseArtifact: artifact, parsed };
}
