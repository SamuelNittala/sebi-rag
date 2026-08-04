import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ArtifactDescriptor } from "@mf-rag/types";

import { parsePDF, type ParsedPDF } from "../parsers/pdf-parser.ts";
import {
  extractTables,
  type TableExtractionResult,
} from "../parsers/table-parser.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PARSED_MEDIA_TYPE = "application/vnd.mf-rag.normalized-pdf+json;version=1";

export interface NormalizedPdfParseArtifact {
  readonly schemaVersion: 1;
  readonly documentVersionId: string;
  readonly source: {
    readonly filename: string;
    readonly canonicalUrl: string;
    readonly rawSha256: string;
    readonly rawByteSize: number;
  };
  readonly parser: {
    readonly parserVersion: string;
    readonly tableExtractorVersion: string;
  };
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly text: string;
    readonly hasTable: boolean;
  }[];
  readonly tables: readonly {
    readonly pageNumber: number;
    readonly tableIndex: number;
    readonly rows: readonly (readonly string[])[];
    readonly markdown: string;
  }[];
  readonly diagnostics: {
    readonly pageCount: number;
    readonly emptyPageCount: number;
    readonly tableCount: number;
    readonly tableExtractionStatus: "succeeded" | "failed";
    readonly tableExtractionCode: "TABLE_EXTRACTION_FAILED" | null;
  };
}

export interface PdfStageArtifactStore {
  verify(descriptor: ArtifactDescriptor): Promise<ArtifactDescriptor>;
  read(descriptor: ArtifactDescriptor): Promise<Uint8Array>;
  put(input: {
    readonly namespace: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly byteSize: number;
    readonly mediaType: string;
    readonly producerVersion: string;
  }): Promise<ArtifactDescriptor>;
}

export interface ParsePdfStageDependencies {
  readonly artifactStore: PdfStageArtifactStore;
  readonly parseFile?: (path: string) => Promise<ParsedPDF>;
  readonly extractTablesFromFile?: (path: string) => Promise<TableExtractionResult>;
}

export interface ParsePdfStageOptions {
  readonly parserVersion: string;
  readonly tableExtractorVersion: string;
  readonly producerVersion: string;
}

export interface ParsePdfStageInput {
  readonly documentVersionId: string;
  readonly rawArtifact: ArtifactDescriptor;
  readonly filename: string;
  readonly canonicalUrl: string;
  readonly signal?: AbortSignal;
}

export interface ParsePdfStageResult {
  readonly artifact: ArtifactDescriptor;
  readonly parsed: NormalizedPdfParseArtifact;
}

/**
 * Artifact boundary for PDF parsing. Temporary paths are an implementation
 * detail only and are deliberately absent from the normalized output.
 */
export class ParsePdfStage {
  constructor(
    private readonly dependencies: ParsePdfStageDependencies,
    private readonly options: ParsePdfStageOptions,
  ) {
    assertCanonical(options.parserVersion, "Parser version");
    assertCanonical(options.tableExtractorVersion, "Table extractor version");
    assertCanonical(options.producerVersion, "Parse artifact producer version");
  }

  async execute(input: ParsePdfStageInput): Promise<ParsePdfStageResult> {
    assertCanonical(input.documentVersionId, "Document version ID");
    assertCanonical(input.filename, "Document filename");
    const canonicalUrl = canonicalHttpUrl(input.canonicalUrl);
    if (input.rawArtifact.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
      throw deterministicParseError("INVALID_RAW_MEDIA_TYPE", "Parse stage accepts application/pdf artifacts only.");
    }
    input.signal?.throwIfAborted();
    const verified = await this.dependencies.artifactStore.verify(input.rawArtifact);
    const rawBytes = await this.dependencies.artifactStore.read(verified);
    assertBytesMatchDescriptor(rawBytes, verified);
    input.signal?.throwIfAborted();

    const parsed = await withTemporaryPdf(input.filename, rawBytes, async (path) => {
      const [pdf, tables] = await Promise.all([
        (this.dependencies.parseFile ?? parsePDF)(path),
        (this.dependencies.extractTablesFromFile ?? extractTables)(path),
      ]);
      return normalizeParseArtifact({
        documentVersionId: input.documentVersionId,
        filename: input.filename,
        canonicalUrl,
        rawArtifact: verified,
        parsedPdf: pdf,
        tableResult: tables,
        parserVersion: this.options.parserVersion,
        tableExtractorVersion: this.options.tableExtractorVersion,
      });
    });
    input.signal?.throwIfAborted();
    const bytes = encodeNormalizedParseArtifact(parsed);
    const sha256 = sha256Hex(bytes);
    const artifact = await this.dependencies.artifactStore.put({
      namespace: `parsed/${input.documentVersionId}`,
      bytes,
      sha256,
      byteSize: bytes.byteLength,
      mediaType: PARSED_MEDIA_TYPE,
      producerVersion: this.options.producerVersion,
    });
    return { artifact, parsed };
  }
}

export function normalizeParseArtifact(input: {
  readonly documentVersionId: string;
  readonly filename: string;
  readonly canonicalUrl: string;
  readonly rawArtifact: Pick<ArtifactDescriptor, "sha256" | "byteSize">;
  readonly parsedPdf: ParsedPDF;
  readonly tableResult: TableExtractionResult;
  readonly parserVersion: string;
  readonly tableExtractorVersion: string;
}): NormalizedPdfParseArtifact {
  const pages = input.parsedPdf.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: page.text,
    hasTable: page.hasTable,
  }));
  if (input.parsedPdf.pageCount <= 0 || pages.length !== input.parsedPdf.pageCount) {
    throw deterministicParseError("EMPTY_OR_INCOMPLETE_PARSE", "PDF parser returned an empty or incomplete page set.");
  }
  if (pages.every((page) => !page.text.trim()) && input.tableResult.tables.length === 0) {
    throw deterministicParseError("EMPTY_PARSED_CONTENT", "PDF parser and table extractor returned no content.");
  }
  for (const [index, page] of pages.entries()) {
    if (page.pageNumber !== index + 1) {
      throw deterministicParseError("INVALID_PAGE_PROVENANCE", "Parsed pages must be complete, ordered, and one-indexed.");
    }
  }
  const tables = input.tableResult.tables
    .map((table) => ({
      pageNumber: table.page,
      tableIndex: table.tableIndex,
      rows: table.rows.map((row) => [...row]),
      markdown: table.markdown,
    }))
    .sort((left, right) => left.pageNumber - right.pageNumber || left.tableIndex - right.tableIndex);
  if (tables.some((table) => table.pageNumber < 1 || table.pageNumber > pages.length)) {
    throw deterministicParseError("INVALID_TABLE_PROVENANCE", "Extracted table points outside the parsed page range.");
  }
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
      parserVersion: input.parserVersion,
      tableExtractorVersion: input.tableExtractorVersion,
    },
    pages,
    tables,
    diagnostics: {
      pageCount: pages.length,
      emptyPageCount: pages.filter((page) => !page.text.trim()).length,
      tableCount: tables.length,
      tableExtractionStatus: input.tableResult.error?.trim() ? "failed" : "succeeded",
      // Never persist subprocess error text: it can contain worker-local paths.
      tableExtractionCode: input.tableResult.error?.trim() ? "TABLE_EXTRACTION_FAILED" : null,
    },
  };
}

export function encodeNormalizedParseArtifact(artifact: NormalizedPdfParseArtifact): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(artifact));
}

export function decodeNormalizedParseArtifact(bytes: Uint8Array): NormalizedPdfParseArtifact {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", "Parsed artifact is not valid JSON.");
  }
  assertNormalizedParseArtifact(value);
  return value;
}

export function parsedPdfMediaType(): string {
  return PARSED_MEDIA_TYPE;
}

function assertNormalizedParseArtifact(value: unknown): asserts value is NormalizedPdfParseArtifact {
  if (!value || typeof value !== "object") {
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", "Parsed artifact must be an object.");
  }
  const artifact = value as Partial<NormalizedPdfParseArtifact>;
  if (artifact.schemaVersion !== 1
    || typeof artifact.documentVersionId !== "string"
    || !artifact.source
    || typeof artifact.source.filename !== "string"
    || typeof artifact.source.canonicalUrl !== "string"
    || !SHA256_PATTERN.test(artifact.source.rawSha256 ?? "")
    || !Number.isSafeInteger(artifact.source.rawByteSize)
    || !artifact.parser
    || typeof artifact.parser.parserVersion !== "string"
    || typeof artifact.parser.tableExtractorVersion !== "string"
    || !Array.isArray(artifact.pages)
    || artifact.pages.length === 0
    || artifact.pages.length !== artifact.diagnostics?.pageCount
    || !Array.isArray(artifact.tables)) {
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", "Parsed artifact contract is incomplete or inconsistent.");
  }
  if (artifact.pages.some((page, index) => !page
    || page.pageNumber !== index + 1
    || typeof page.text !== "string"
    || typeof page.hasTable !== "boolean")
    || artifact.tables.some((table) => !table
      || !Number.isSafeInteger(table.pageNumber)
      || table.pageNumber < 1
      || table.pageNumber > artifact.pages!.length
      || !Number.isSafeInteger(table.tableIndex)
      || table.tableIndex < 0
      || !Array.isArray(table.rows)
      || table.rows.some((row: readonly string[]) =>
        !Array.isArray(row) || row.some((cell: string) => typeof cell !== "string"))
      || typeof table.markdown !== "string")
    || !artifact.diagnostics
    || !Number.isSafeInteger(artifact.diagnostics.emptyPageCount)
    || artifact.diagnostics.tableCount !== artifact.tables.length
    || !["succeeded", "failed"].includes(artifact.diagnostics.tableExtractionStatus)
    || (artifact.diagnostics.tableExtractionStatus === "failed") !== (artifact.diagnostics.tableExtractionCode === "TABLE_EXTRACTION_FAILED")) {
    throw deterministicParseError("INVALID_PARSED_ARTIFACT", "Parsed artifact page, table, or diagnostic provenance is invalid.");
  }
}

async function withTemporaryPdf<T>(filename: string, bytes: Uint8Array, operation: (path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "mf-rag-parse-"));
  const safeName = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_") || "document.pdf";
  const path = join(root, safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`);
  try {
    await writeFile(path, bytes, { flag: "wx" });
    return await operation(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function assertBytesMatchDescriptor(bytes: Uint8Array, descriptor: ArtifactDescriptor): void {
  const checksum = sha256Hex(bytes);
  if (bytes.byteLength !== descriptor.byteSize || checksum !== descriptor.sha256) {
    throw deterministicParseError("RAW_ARTIFACT_CHECKSUM_MISMATCH", "Raw artifact bytes do not match their immutable descriptor.");
  }
}

function canonicalHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw deterministicParseError("INVALID_SOURCE_URL", "Canonical source URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw deterministicParseError("INVALID_SOURCE_URL", "Canonical source URL must not contain inline credentials.");
  }
  url.hash = "";
  return url.toString();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertCanonical(value: string, label: string): void {
  if (!value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a canonical non-empty value.`);
  }
}

function deterministicParseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
