import {
  and,
  artifacts,
  documentVersions,
  eq,
  sourceDocuments,
  sources,
  type Database,
} from "@mf-rag/db";
import { sourceParsers, type ArtifactDescriptor, type SourceParser } from "@mf-rag/types";

import type { StageHandlerContext, StageHandlerResult } from "../runtime/stage-registry.ts";

export interface ParseDocumentAdapter {
  execute(input: {
    readonly documentVersionId: string;
    readonly rawArtifact: ArtifactDescriptor;
    readonly filename: string;
    readonly canonicalUrl: string;
    readonly parser: SourceParser;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly artifact: ArtifactDescriptor }>;
}

export interface ParseDocumentRepository {
  loadInput(context: StageHandlerContext): Promise<{
    readonly rawArtifact: ArtifactDescriptor;
    readonly filename: string;
    readonly canonicalUrl: string;
    readonly parser: SourceParser;
  }>;
}

/**
 * Routes each PARSE input to the parser its source selects. `docling: null`
 * means the worker has no Docling service configured.
 */
export function createParserRoutingAdapter(adapters: {
  readonly unpdf: ParseDocumentAdapter;
  readonly docling: ParseDocumentAdapter | null;
}): ParseDocumentAdapter {
  return {
    async execute(input) {
      if (input.parser === "unpdf") return adapters.unpdf.execute(input);
      if (!adapters.docling) {
        throw deterministicError("DOCLING_PARSER_NOT_CONFIGURED", "Source selects Docling but PIPELINE_DOCLING_SERVICE_URL is not set.");
      }
      return adapters.docling.execute(input);
    },
  };
}

/** Thin durable-worker adapter; parsing behavior remains in the ingestion package. */
export class ParseDocumentStage {
  constructor(private readonly options: {
    readonly repository: ParseDocumentRepository;
    readonly adapter: ParseDocumentAdapter;
  }) {}

  async execute(context: StageHandlerContext): Promise<StageHandlerResult> {
    const input = await this.options.repository.loadInput(context);
    if (input.rawArtifact.sha256 !== context.inputChecksum) {
      throw deterministicError("RAW_INPUT_CHECKSUM_MISMATCH", "PARSE input does not match the version-owned raw artifact.");
    }
    const result = await this.options.adapter.execute({
      documentVersionId: context.documentVersionId,
      rawArtifact: input.rawArtifact,
      filename: input.filename,
      canonicalUrl: input.canonicalUrl,
      parser: input.parser,
      signal: context.signal,
    });
    return {
      outputRef: encodeArtifactOutputRef(result.artifact),
      outputChecksum: result.artifact.sha256,
    };
  }
}

export function createDatabaseParseDocumentRepository(db: Database): ParseDocumentRepository {
  return {
    async loadInput(context) {
      const [row] = await db.select({
        version: documentVersions,
        document: sourceDocuments,
        artifact: artifacts,
        parseConfig: sources.parseConfig,
      }).from(documentVersions)
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, documentVersions.sourceDocumentId))
        .innerJoin(artifacts, eq(artifacts.id, documentVersions.rawArtifactId))
        .innerJoin(sources, eq(sources.id, documentVersions.sourceId))
        .where(and(
          eq(documentVersions.id, context.documentVersionId),
          eq(documentVersions.accessScopeId, context.accessScopeId),
          eq(documentVersions.sourceId, context.sourceId),
        )).limit(1);
      if (!row) throw deterministicError("VERSION_OWNERSHIP_MISMATCH", "PARSE version ownership does not match its stage envelope.");
      const rawArtifact: ArtifactDescriptor = {
        key: row.artifact.artifactKey,
        uri: row.artifact.uri,
        sha256: row.artifact.sha256,
        byteSize: row.artifact.byteSize,
        mediaType: row.artifact.mediaType,
        producerVersion: row.artifact.producerVersion,
      };
      const parser = row.parseConfig?.parser ?? "unpdf";
      if (!sourceParsers.includes(parser)) {
        throw deterministicError("UNKNOWN_SOURCE_PARSER", "Source parse configuration names an unknown parser.");
      }
      return {
        rawArtifact,
        filename: filenameFromUrl(row.document.canonicalUrl, row.document.logicalDocumentKey),
        canonicalUrl: row.document.canonicalUrl,
        parser,
      };
    },
  };
}

export function encodeArtifactOutputRef(descriptor: ArtifactDescriptor): string {
  const value = JSON.stringify(descriptor);
  if (value.length > 2_000) throw deterministicError("ARTIFACT_REFERENCE_TOO_LONG", "Artifact reference exceeds the durable stage contract.");
  return value;
}

export function decodeArtifactOutputRef(value: string): ArtifactDescriptor {
  let descriptor: unknown;
  try { descriptor = JSON.parse(value); } catch {
    throw deterministicError("INVALID_ARTIFACT_REFERENCE", "Stage output reference is not valid artifact JSON.");
  }
  if (!descriptor || typeof descriptor !== "object") {
    throw deterministicError("INVALID_ARTIFACT_REFERENCE", "Stage output reference is not an artifact descriptor.");
  }
  const result = descriptor as Partial<ArtifactDescriptor>;
  if (!result.key || !result.uri || !/^[0-9a-f]{64}$/.test(result.sha256 ?? "")
    || !Number.isSafeInteger(result.byteSize) || !result.mediaType || !result.producerVersion) {
    throw deterministicError("INVALID_ARTIFACT_REFERENCE", "Stage artifact reference is incomplete.");
  }
  return result as ArtifactDescriptor;
}

function filenameFromUrl(value: string, fallback: string): string {
  const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1);
  return segment ? decodeURIComponent(segment) : `${fallback}.pdf`;
}

function deterministicError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
