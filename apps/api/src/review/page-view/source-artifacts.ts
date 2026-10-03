/**
 * Resolves a review run to its version-owned raw PDF and Docling parse
 * artifact, and loads them from the artifact store with integrity checks.
 *
 * Everything is derived from the run row (run -> document version -> raw
 * artifact; run -> pipeline run -> PARSE attempt `output_ref`); no artifact key,
 * URI or version id is ever taken from a request.
 *
 * Decoded parse artifacts are immutable and content-addressed, so an LRU keyed
 * by artifact sha256 is never stale. Concurrent loads of one artifact share a
 * single store read; failed loads are not cached.
 */

import type { ArtifactDescriptor } from "@mf-rag/types";
import type { Database } from "@mf-rag/db/client";
import { getReviewRunSourceLineage, type ReviewRunSourceLineage } from "@mf-rag/db/review-queries";

import type { ArtifactStore } from "../../../../pipeline/src/artifacts/artifact-store.ts";
import { decodeArtifactOutputRef } from "../../../../pipeline/src/stages/parse-document.ts";
import type { DoclingWireChunk } from "../../../../ingestion/src/parsers/docling-contract.ts";
import {
  decodeDoclingParseArtifact,
  doclingPdfMediaType,
  type DoclingPdfParseArtifact,
} from "../../../../ingestion/src/stages/docling-parse-stage.ts";

export const DEFAULT_ARTIFACT_CACHE_ENTRIES = 4;

/** Error codes shown on the page view (never URIs, keys or messages from the store). */
export type ReviewSourceErrorCode =
  /** The run's pipeline run belongs to another document version (or is gone). */
  | "LINEAGE_MISMATCH"
  /** The PARSE `output_ref` is not a complete artifact descriptor. */
  | "INVALID_ARTIFACT_REFERENCE"
  /** The version's raw artifact is not `application/pdf`. */
  | "RAW_NOT_PDF"
  /** Store read failed: missing object, size or checksum mismatch. */
  | "ARTIFACT_READ_FAILED"
  /** Bytes are not a valid Docling parse artifact. */
  | "INVALID_PARSED_ARTIFACT"
  /** `artifact.documentVersionId` differs from the run's document version. */
  | "ARTIFACT_VERSION_MISMATCH"
  /** `artifact.source.rawSha256` differs from the version's raw artifact sha256. */
  | "RAW_SHA_MISMATCH";

export class ReviewSourceError extends Error {
  constructor(readonly code: ReviewSourceErrorCode, options?: { cause?: unknown }) {
    super(`Review source artifact error: ${code}.`, options);
    this.name = "ReviewSourceError";
  }
}

export interface DoclingSourceLineage {
  readonly kind: "docling";
  readonly runId: string;
  readonly documentVersionId: string;
  readonly pipelineRunId: string;
  readonly sourceName: string;
  readonly parserVersion: string;
  readonly rawArtifact: ArtifactDescriptor;
  readonly parseArtifact: ArtifactDescriptor;
}

export type ReviewSourceResolution =
  | DoclingSourceLineage
  | { readonly kind: "not_found" }
  /** `legacy_run`: no document version / pipeline run; `parse_output_missing`: no usable PARSE attempt. */
  | { readonly kind: "no_lineage"; readonly reason: "legacy_run" | "parse_output_missing"; readonly parserVersion: string }
  /** Parsed by another parser (unpdf media type). */
  | { readonly kind: "not_docling"; readonly parserVersion: string; readonly mediaType: string }
  | { readonly kind: "error"; readonly code: ReviewSourceErrorCode };

export interface LoadedDoclingArtifact {
  readonly sha256: string;
  readonly artifact: DoclingPdfParseArtifact;
  readonly pageCount: number;
  /** Wire chunks with `page` in `pages`, in chunk-index order; empty for pages without chunks. */
  chunksOnPage(page: number): readonly DoclingWireChunk[];
}

/** Pure: maps a lineage row to a resolution (no store access). */
export function resolveSourceLineage(row: ReviewRunSourceLineage | undefined): ReviewSourceResolution {
  if (!row) return { kind: "not_found" };
  const { run, rawArtifact } = row;
  const parserVersion = run.parserVersion;
  if (!run.documentVersionId || !run.pipelineRunId || !rawArtifact) {
    return { kind: "no_lineage", reason: "legacy_run", parserVersion };
  }
  if (row.pipelineRunDocumentVersionId !== run.documentVersionId) return { kind: "error", code: "LINEAGE_MISMATCH" };
  if (!row.parseOutputRef) return { kind: "no_lineage", reason: "parse_output_missing", parserVersion };
  let parseArtifact: ArtifactDescriptor;
  try {
    parseArtifact = decodeArtifactOutputRef(row.parseOutputRef);
  } catch {
    return { kind: "error", code: "INVALID_ARTIFACT_REFERENCE" };
  }
  if (parseArtifact.mediaType !== doclingPdfMediaType()) {
    return { kind: "not_docling", parserVersion, mediaType: parseArtifact.mediaType };
  }
  if (baseMediaType(rawArtifact.mediaType) !== "application/pdf") return { kind: "error", code: "RAW_NOT_PDF" };
  return {
    kind: "docling",
    runId: run.id,
    documentVersionId: run.documentVersionId,
    pipelineRunId: run.pipelineRunId,
    sourceName: run.sourceName,
    parserVersion,
    rawArtifact,
    parseArtifact,
  };
}

export interface ReviewSourceArtifactsOptions {
  /** Decoded parse artifacts kept in memory (default 4). */
  readonly cacheEntries?: number;
}

export class ReviewSourceArtifacts {
  readonly #cacheEntries: number;
  /** Insertion order is recency order (oldest first); entries may still be in flight. */
  readonly #cache = new Map<string, Promise<LoadedDoclingArtifact>>();

  constructor(
    private readonly db: Database,
    private readonly store: Pick<ArtifactStore, "readVerified">,
    options: ReviewSourceArtifactsOptions = {},
  ) {
    const cacheEntries = options.cacheEntries ?? DEFAULT_ARTIFACT_CACHE_ENTRIES;
    if (!Number.isSafeInteger(cacheEntries) || cacheEntries < 1) {
      throw new Error("Review source artifact cache size must be a positive integer.");
    }
    this.#cacheEntries = cacheEntries;
  }

  /** Looks up the run's lineage in the database and resolves it. */
  async resolve(runId: string): Promise<ReviewSourceResolution> {
    return resolveSourceLineage(await getReviewRunSourceLineage(this.db, runId));
  }

  /**
   * Reads (or reuses from cache) and decodes the parse artifact, then checks it
   * belongs to the lineage's document version and raw PDF. Throws ReviewSourceError.
   */
  async loadDoclingArtifact(lineage: DoclingSourceLineage): Promise<LoadedDoclingArtifact> {
    const loaded = await this.#cachedLoad(lineage.parseArtifact);
    if (loaded.artifact.documentVersionId !== lineage.documentVersionId) {
      throw new ReviewSourceError("ARTIFACT_VERSION_MISMATCH");
    }
    if (loaded.artifact.source.rawSha256 !== lineage.rawArtifact.sha256) {
      throw new ReviewSourceError("RAW_SHA_MISMATCH");
    }
    return loaded;
  }

  /** Reads the raw PDF with size and checksum verification (not cached). Throws ReviewSourceError. */
  async loadRawPdf(lineage: DoclingSourceLineage): Promise<Uint8Array> {
    return this.#read(lineage.rawArtifact);
  }

  #cachedLoad(descriptor: ArtifactDescriptor): Promise<LoadedDoclingArtifact> {
    const key = descriptor.sha256;
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const pending = this.#read(descriptor).then((bytes) => decodeLoaded(descriptor.sha256, bytes));
    this.#cache.set(key, pending);
    pending.catch(() => {
      if (this.#cache.get(key) === pending) this.#cache.delete(key);
    });
    while (this.#cache.size > this.#cacheEntries) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    return pending;
  }

  async #read(descriptor: ArtifactDescriptor): Promise<Uint8Array> {
    try {
      return await this.store.readVerified(descriptor);
    } catch (error) {
      throw new ReviewSourceError("ARTIFACT_READ_FAILED", { cause: error });
    }
  }
}

function decodeLoaded(sha256: string, bytes: Uint8Array): LoadedDoclingArtifact {
  let artifact: DoclingPdfParseArtifact;
  try {
    artifact = decodeDoclingParseArtifact(bytes);
  } catch (error) {
    throw new ReviewSourceError("INVALID_PARSED_ARTIFACT", { cause: error });
  }
  const byPage = new Map<number, DoclingWireChunk[]>();
  for (const chunk of artifact.chunks) {
    for (const page of chunk.pages) {
      const chunks = byPage.get(page) ?? [];
      chunks.push(chunk);
      byPage.set(page, chunks);
    }
  }
  return {
    sha256,
    artifact,
    pageCount: artifact.diagnostics.pageCount,
    chunksOnPage: (page) => byPage.get(page) ?? [],
  };
}

function baseMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
