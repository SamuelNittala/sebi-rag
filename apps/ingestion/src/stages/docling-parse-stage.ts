import type { ArtifactDescriptor } from "@mf-rag/types";

import { parseWithDocling, type DoclingParseRequestOptions } from "../parsers/docling-client.ts";
import {
  assertDoclingDroppedPictures,
  assertDoclingPageStats,
  assertDoclingWireChunks,
  countDoclingFlags,
  type DoclingDroppedPictures,
  type DoclingNormalizationFlag,
  type DoclingPageStats,
  type DoclingParseResponse,
  type DoclingWireChunk,
} from "../parsers/docling-contract.ts";
import {
  assertBytesMatchDescriptor,
  assertCanonical,
  canonicalHttpUrl,
  deterministicParseError,
  sha256Hex,
  type ParsePdfStageInput,
  type PdfStageArtifactStore,
} from "./parse-pdf-stage.ts";

const DOCLING_PDF_MEDIA_TYPE = "application/vnd.mf-rag.docling-pdf+json;version=1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Stored Docling parse artifact. A structural superset of the unpdf artifact's
 * `pages[].text` so metadata extraction and the addendum chunker keep working.
 * Excludes `conversionMs` and the raw artifact location so the checksum is
 * stable across runs and workers.
 */
export interface DoclingPdfParseArtifact {
  readonly schemaVersion: 1;
  readonly documentVersionId: string;
  readonly source: {
    readonly filename: string;
    readonly canonicalUrl: string;
    readonly rawSha256: string;
    readonly rawByteSize: number;
  };
  readonly parser: {
    readonly kind: "docling";
    readonly parserVersion: string;
    readonly tableExtractorVersion: string;
  };
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly text: string;
    readonly hasTable: boolean;
    readonly stats: DoclingPageStats;
  }[];
  readonly chunks: readonly DoclingWireChunk[];
  readonly diagnostics: {
    readonly pageCount: number;
    readonly emptyPageCount: number;
    /** Sum of Docling-detected tables over all pages. */
    readonly tableCount: number;
    readonly pictureChunkCount: number;
    readonly flagCounts: Readonly<Partial<Record<DoclingNormalizationFlag, number>>>;
    readonly droppedPictures: DoclingDroppedPictures;
  };
}

export interface DoclingParseStageDependencies {
  readonly artifactStore: PdfStageArtifactStore;
  readonly parse?: (bytes: Uint8Array, options: DoclingParseRequestOptions) => Promise<DoclingParseResponse>;
}

export interface DoclingParseStageOptions {
  readonly serviceUrl: string;
  /** Expected `producer.parserVersion` (PIPELINE_DOCLING_PARSER_VERSION). */
  readonly parserVersion: string;
  readonly producerVersion: string;
  readonly deadlineMs?: number;
  readonly maxPages?: number;
  readonly maxTextChars?: number;
  readonly maxResponseBytes?: number;
}

export interface DoclingParseStageInput extends ParsePdfStageInput {
  /** Source `parse.fundNamePrefixes`, forwarded to the service for the side-by-side fund table split. */
  readonly fundNamePrefixes?: readonly string[];
}

export interface DoclingParseStageResult {
  readonly artifact: ArtifactDescriptor;
  readonly parsed: DoclingPdfParseArtifact;
}

/** Artifact boundary for Docling parsing; same integrity checks as ParsePdfStage. */
export class DoclingParseStage {
  constructor(
    private readonly dependencies: DoclingParseStageDependencies,
    private readonly options: DoclingParseStageOptions,
  ) {
    assertCanonical(options.serviceUrl, "Docling service URL");
    assertCanonical(options.parserVersion, "Docling parser version");
    assertCanonical(options.producerVersion, "Docling parse artifact producer version");
    for (const [name, value] of Object.entries(doclingLimits(options))) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    }
  }

  async execute(input: DoclingParseStageInput): Promise<DoclingParseStageResult> {
    assertCanonical(input.documentVersionId, "Document version ID");
    assertCanonical(input.filename, "Document filename");
    const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);
    if (input.rawArtifact.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
      throw deterministicParseError("INVALID_RAW_MEDIA_TYPE", "Parse stage accepts application/pdf artifacts only.");
    }
    input.signal?.throwIfAborted();
    const rawBytes = await this.dependencies.artifactStore.readVerified(input.rawArtifact);
    assertBytesMatchDescriptor(rawBytes, input.rawArtifact);
    input.signal?.throwIfAborted();

    const limits = doclingLimits(this.options);
    const deadline = AbortSignal.timeout(limits.deadlineMs);
    let response: DoclingParseResponse;
    try {
      response = await (this.dependencies.parse ?? parseWithDocling)(rawBytes, {
        baseUrl: this.options.serviceUrl,
        expectedParserVersion: this.options.parserVersion,
        maxResponseBytes: limits.maxResponseBytes,
        ...(input.fundNamePrefixes ? { fundNamePrefixes: input.fundNamePrefixes } : {}),
        signal: AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])]),
      });
    } catch (error) {
      if (deadline.aborted && !input.signal?.aborted) {
        throw deterministicParseError("PARSE_DEADLINE_EXCEEDED", `Docling parsing exceeded ${limits.deadlineMs}ms.`);
      }
      throw error;
    }
    input.signal?.throwIfAborted();
    assertResponseLimits(response, limits);

    const parsed = buildDoclingParseArtifact({
      documentVersionId: input.documentVersionId,
      filename: input.filename,
      canonicalUrl,
      rawArtifact: input.rawArtifact,
      response,
    });
    const bytes = encodeDoclingParseArtifact(parsed);
    const artifact = await this.dependencies.artifactStore.put({
      namespace: `parsed/${input.documentVersionId}`,
      bytes,
      sha256: sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: DOCLING_PDF_MEDIA_TYPE,
      producerVersion: this.options.producerVersion,
    });
    return { artifact, parsed };
  }
}

interface DoclingLimits {
  readonly deadlineMs: number;
  readonly maxPages: number;
  readonly maxTextChars: number;
  readonly maxResponseBytes: number;
}

function doclingLimits(options: DoclingParseStageOptions): DoclingLimits {
  return {
    deadlineMs: options.deadlineMs ?? 1_800_000,
    maxPages: options.maxPages ?? 500,
    maxTextChars: options.maxTextChars ?? 10_000_000,
    maxResponseBytes: options.maxResponseBytes ?? 50_000_000,
  };
}

function assertResponseLimits(response: DoclingParseResponse, limits: DoclingLimits): void {
  if (response.pageCount > limits.maxPages) {
    throw deterministicParseError("PDF_PAGE_LIMIT_EXCEEDED", `PDF exceeds the ${limits.maxPages}-page limit.`);
  }
  const textCharacters = response.pages.reduce((total, page) => total + page.text.length, 0)
    + response.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  if (textCharacters > limits.maxTextChars) {
    throw deterministicParseError("PDF_TEXT_LIMIT_EXCEEDED", `PDF text exceeds the ${limits.maxTextChars}-character limit.`);
  }
}

function buildDoclingParseArtifact(input: {
  readonly documentVersionId: string;
  readonly filename: string;
  readonly canonicalUrl: string;
  readonly rawArtifact: Pick<ArtifactDescriptor, "sha256" | "byteSize">;
  readonly response: DoclingParseResponse;
}): DoclingPdfParseArtifact {
  const { response } = input;
  const pages = response.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text,
    hasTable: page.hasTable,
    stats: { ...page.stats },
  }));
  return {
    schemaVersion: 1,
    documentVersionId: input.documentVersionId,
    source: {
      filename: input.filename,
      canonicalUrl: input.canonicalUrl,
      rawSha256: input.rawArtifact.sha256,
      rawByteSize: input.rawArtifact.byteSize,
    },
    parser: {
      kind: "docling",
      parserVersion: response.producer.parserVersion,
      tableExtractorVersion: `docling-tableformer-accurate+norm-${response.producer.normalizerVersion}`,
    },
    pages,
    chunks: response.chunks,
    diagnostics: artifactDiagnostics(pages, response.chunks, response.diagnostics.droppedPictures),
  };
}

function artifactDiagnostics(
  pages: DoclingPdfParseArtifact["pages"],
  chunks: readonly DoclingWireChunk[],
  droppedPictures: DoclingDroppedPictures,
): DoclingPdfParseArtifact["diagnostics"] {
  return {
    pageCount: pages.length,
    emptyPageCount: pages.filter((page) => !page.text.trim()).length,
    tableCount: pages.reduce((total, page) => total + page.stats.tables, 0),
    pictureChunkCount: chunks.filter((chunk) => chunk.type === "picture").length,
    flagCounts: countDoclingFlags(chunks),
    droppedPictures: { ...droppedPictures },
  };
}

export function encodeDoclingParseArtifact(artifact: DoclingPdfParseArtifact): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(artifact));
}

export function decodeDoclingParseArtifact(bytes: Uint8Array): DoclingPdfParseArtifact {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", "Docling parse artifact is not valid JSON.");
  }
  try {
    assertDoclingParseArtifact(value);
  } catch (error) {
    // Contract helpers throw INVALID_DOCLING_RESPONSE; a stored artifact is a parsed artifact.
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", (error as Error).message);
  }
  return value;
}

export function doclingPdfMediaType(): string {
  return DOCLING_PDF_MEDIA_TYPE;
}

function assertDoclingParseArtifact(value: unknown): asserts value is DoclingPdfParseArtifact {
  const artifact = exactObject(value, "artifact", [
    "schemaVersion", "documentVersionId", "source", "parser", "pages", "chunks", "diagnostics",
  ]);
  if (artifact.schemaVersion !== 1 || typeof artifact.documentVersionId !== "string" || !artifact.documentVersionId) {
    invalid("artifact schema version or document version ID is invalid");
  }
  const source = exactObject(artifact.source, "source", ["filename", "canonicalUrl", "rawSha256", "rawByteSize"]);
  if (typeof source.filename !== "string" || typeof source.canonicalUrl !== "string"
    || typeof source.rawSha256 !== "string" || !SHA256_PATTERN.test(source.rawSha256)
    || !Number.isSafeInteger(source.rawByteSize)) {
    invalid("source provenance is invalid");
  }
  const parser = exactObject(artifact.parser, "parser", ["kind", "parserVersion", "tableExtractorVersion"]);
  if (parser.kind !== "docling" || typeof parser.parserVersion !== "string" || !parser.parserVersion
    || typeof parser.tableExtractorVersion !== "string" || !parser.tableExtractorVersion) {
    invalid("parser identity is invalid");
  }
  if (!Array.isArray(artifact.pages) || artifact.pages.length === 0) invalid("pages must be a non-empty array");
  artifact.pages.forEach((value: unknown, index: number) => {
    const page = exactObject(value, `pages[${index}]`, ["pageNumber", "text", "hasTable", "stats"]);
    if (page.pageNumber !== index + 1 || typeof page.text !== "string" || page.text.includes("\u0000")
      || typeof page.hasTable !== "boolean") {
      invalid(`pages[${index}] provenance is invalid`);
    }
    assertDoclingPageStats(page.stats, `pages[${index}].stats`);
    if (page.hasTable !== page.stats.tables > 0) invalid(`pages[${index}].hasTable must equal stats.tables > 0`);
  });
  assertDoclingWireChunks(artifact.chunks, artifact.pages.length);
  const diagnostics = exactObject(artifact.diagnostics, "diagnostics", [
    "pageCount", "emptyPageCount", "tableCount", "pictureChunkCount", "flagCounts", "droppedPictures",
  ]);
  assertDoclingDroppedPictures(diagnostics.droppedPictures, "diagnostics.droppedPictures");
  const expected = artifactDiagnostics(artifact.pages, artifact.chunks, diagnostics.droppedPictures);
  if (JSON.stringify(diagnostics) !== JSON.stringify(expected)) {
    invalid("diagnostics do not match the pages and chunks");
  }
}

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${path} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    invalid(`${path} has missing or unknown properties`);
  }
  return value as Record<string, any>;
}

function invalid(message: string): never {
  throw deterministicParseError("INVALID_PARSED_ARTIFACT", `Docling parse artifact ${message}.`);
}
