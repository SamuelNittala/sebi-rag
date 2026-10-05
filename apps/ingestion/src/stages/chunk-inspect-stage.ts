import { createHash } from "node:crypto";

import type {
  ArtifactDescriptor,
  CandidateChunkMetadata,
  ClassifiedKnowledgeOwnership,
  KnowledgeScope,
  SourceDocumentType,
} from "@mf-rag/types";
import { assertClassifiedKnowledgeOwnership } from "@mf-rag/types";
import type { StageInspectionReviewInput } from "@mf-rag/db";

import { chunkAddendum } from "../chunkers/addendum-chunker.ts";
import { mapDoclingChunks, type DoclingParserDiagnostics } from "../chunkers/docling-chunk-mapper.ts";
import { removeDisposableSifChunks } from "../chunkers/disposable-content.ts";
import {
  semanticChunk,
  type ChunkResult,
} from "../chunkers/semantic-chunker.ts";
import {
  extractMetadata,
  extractSchemeCategory,
  extractSchemeType,
  type ExtractedMetadata,
} from "../metadata/extractor.ts";
import {
  prepareChunkReview,
  type PreparedChunkReview,
} from "../review/review-preparation.ts";
import {
  classifyDocumentScope,
  strategyIdForScope,
} from "../review/review-metadata.ts";
import {
  decodeDoclingParseArtifact,
  doclingPdfMediaType,
  type DoclingPdfParseArtifact,
} from "./docling-parse-stage.ts";
import {
  decodeNormalizedParseArtifact,
  parsedPdfMediaType,
  type NormalizedPdfParseArtifact,
  type PdfStageArtifactStore,
} from "./parse-pdf-stage.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Either stored PDF parse artifact; Docling adds chunks, unpdf adds tables. */
export type PdfParseArtifact = NormalizedPdfParseArtifact | DoclingPdfParseArtifact;

export interface PdfCitationMetadata {
  readonly sebiSchemeId?: string;
  readonly sebiUrl?: string;
  readonly amcName?: string;
  readonly schemeType?: string;
  readonly schemeCategory?: string;
}

export interface PreparedPdfChunkInspection {
  readonly metadata: ExtractedMetadata;
  readonly knowledgeScope: KnowledgeScope;
  readonly chunkResult: ChunkResult;
  readonly chunkerVersion: string;
  readonly prepared: PreparedChunkReview;
  readonly sourceAuthority: "regulatory_filing" | "official_product_page" | "unknown";
}

export interface TrustedPdfPipelineContext {
  readonly accessScopeId: string;
  readonly accessScopeKey: string;
  readonly externalCode: string;
  readonly configRevisionId: string;
  readonly configRevisionChecksum: string;
  readonly classification: KnowledgeScope;
}

export interface ChunkInspectionReviewRepository {
  stage(input: StageInspectionReviewInput & {
    readonly documentVersionId: string;
    readonly configRevisionId: string;
    readonly pipelineRunId: string;
  }): Promise<{ readonly id: string }>;
}

export interface ChunkInspectStageOptions {
  readonly artifactStore: Pick<PdfStageArtifactStore, "readVerified">;
  readonly reviewRepository: ChunkInspectionReviewRepository;
}

export interface ChunkInspectStageInput {
  readonly documentVersionId: string;
  readonly pipelineRunId: string;
  readonly sourceDocumentId: string;
  readonly accessScopeId: string;
  readonly parsedArtifact: ArtifactDescriptor;
  readonly expectedParsedChecksum: string;
  readonly trustedContext: TrustedPdfPipelineContext;
  readonly citationMetadata?: PdfCitationMetadata;
  /** Source-declared document type; overrides filename/content detection. */
  readonly documentType?: SourceDocumentType;
  readonly signal?: AbortSignal;
}

export interface ChunkInspectStageResult {
  readonly reviewRunId: string;
  readonly outputChecksum: string;
  readonly candidateCount: number;
}

/** Scheduled adapter: inspection and durable review staging are mandatory. */
export class ChunkInspectStage {
  constructor(private readonly options: ChunkInspectStageOptions) {}

  async execute(input: ChunkInspectStageInput): Promise<ChunkInspectStageResult> {
    assertTrustedContext(input.trustedContext, input.accessScopeId);
    if (!SHA256_PATTERN.test(input.expectedParsedChecksum)
      || input.parsedArtifact.sha256 !== input.expectedParsedChecksum) {
      throw deterministicChunkError("PARSED_ARTIFACT_CHECKSUM_MISMATCH", "Parsed artifact checksum does not match the stage input.");
    }
    const decode = input.parsedArtifact.mediaType === parsedPdfMediaType()
      ? decodeNormalizedParseArtifact
      : input.parsedArtifact.mediaType === doclingPdfMediaType()
        ? decodeDoclingParseArtifact
        : null;
    if (!decode) {
      throw deterministicChunkError("INVALID_PARSED_MEDIA_TYPE", "Chunk stage accepts only the normalized or Docling PDF artifact contracts.");
    }
    input.signal?.throwIfAborted();
    const bytes = await this.options.artifactStore.readVerified(input.parsedArtifact);
    if (sha256Hex(bytes) !== input.parsedArtifact.sha256 || bytes.byteLength !== input.parsedArtifact.byteSize) {
      throw deterministicChunkError("PARSED_ARTIFACT_CHECKSUM_MISMATCH", "Parsed artifact bytes failed integrity verification.");
    }
    const parsed: PdfParseArtifact = decode(bytes);
    if (parsed.documentVersionId !== input.documentVersionId) {
      throw deterministicChunkError("PARSED_VERSION_MISMATCH", "Parsed artifact belongs to another document version.");
    }
    assertScheduledSourceUrl(parsed.source.canonicalUrl);
    input.signal?.throwIfAborted();
    const ownership = ownershipFromTrustedContext(input.trustedContext);
    const inspection = preparePdfChunkInspection({
      parsed,
      sourceDocumentId: input.sourceDocumentId,
      ownership,
      knowledgeScope: input.trustedContext.classification,
      citationMetadata: input.citationMetadata,
      documentType: input.documentType,
    });
    const reviewRun = await this.options.reviewRepository.stage({
      sourceType: "pdf",
      sourceDocumentId: input.sourceDocumentId,
      documentVersionId: input.documentVersionId,
      pipelineRunId: input.pipelineRunId,
      configRevisionId: input.trustedContext.configRevisionId,
      sourceName: parsed.source.filename,
      sourceLocation: parsed.source.canonicalUrl,
      fileHash: parsed.source.rawSha256,
      parserVersion: `${parsed.parser.parserVersion}+${parsed.parser.tableExtractorVersion}`,
      chunkerVersion: inspection.chunkerVersion,
      ownership,
      report: inspection.prepared.report,
      candidates: inspection.prepared.candidates,
    });
    return {
      reviewRunId: reviewRun.id,
      outputChecksum: inspectedCandidateChecksum({
        documentVersionId: input.documentVersionId,
        configRevisionChecksum: input.trustedContext.configRevisionChecksum,
        parserVersion: parsed.parser,
        chunkerVersion: inspection.chunkerVersion,
        inspectorVersion: inspection.prepared.report.inspectorVersion,
        ownership,
        candidates: inspection.prepared.candidates,
        report: inspection.prepared.report,
      }),
      candidateCount: inspection.prepared.candidates.length,
    };
  }
}

/** Shared characterization boundary used by scheduled and legacy/manual flows. */
export function preparePdfChunkInspection(input: {
  readonly parsed: PdfParseArtifact;
  readonly sourceDocumentId: string;
  readonly ownership: ClassifiedKnowledgeOwnership;
  readonly knowledgeScope: KnowledgeScope;
  readonly citationMetadata?: PdfCitationMetadata;
  /** Legacy-only hint; scheduled artifacts never depend on a local path. */
  readonly metadataFilepath?: string;
  readonly metadata?: ExtractedMetadata;
  /** Source-declared document type; ignored when `metadata` is supplied. */
  readonly documentType?: SourceDocumentType;
  /** Legacy/manual citation override; omitted by scheduled workers. */
  readonly sourceUrl?: string | null;
}): PreparedPdfChunkInspection {
  assertClassifiedKnowledgeOwnership(input.ownership);
  // PDF text extractors can preserve embedded NUL characters. PostgreSQL text
  // columns reject U+0000, so remove it before metadata extraction, chunking,
  // inspection, hashing, and durable review staging all observe the content.
  const parsed = sanitizePostgresText(input.parsed);
  const sourceUrl = input.sourceUrl === undefined ? parsed.source.canonicalUrl : input.sourceUrl;
  const metadata = input.metadata ?? extractPdfMetadata(parsed, input.metadataFilepath, input.documentType);
  let parserDiagnostics: DoclingParserDiagnostics | null = null;
  let chunkResult: ChunkResult;
  let chunkerVersion: string;
  if (isDoclingArtifact(parsed)) {
    ({ chunkResult, parserDiagnostics } = mapDoclingChunks(parsed));
    chunkerVersion = "docling-hybrid-v1";
  } else {
    chunkResult = semanticChunk({
      pages: parsed.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
      tables: parsed.tables.map((table) => ({ pageNumber: table.pageNumber, markdown: table.markdown })),
    });
    chunkerVersion = "semantic-v1";
  }
  let addendumChunkingMode: "specialized" | "semantic_fallback" | null = null;
  let addendumFallbackReason: "incomplete_metadata" | "unpaired_provisions" | null = null;
  if (metadata.docType === "Addendum") {
    const hasRequiredMetadata = Boolean(
      metadata.fundName && metadata.amendmentNumber && metadata.effectiveDate,
    );
    const addendum = hasRequiredMetadata
      ? chunkAddendum({
          pages: parsed.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
          fundName: metadata.fundName,
          amendmentNumber: metadata.amendmentNumber,
          effectiveDate: metadata.effectiveDate.toISOString().slice(0, 10),
          amendedDocumentTypes: metadata.amendedDocumentTypes,
        })
      : null;
    if (addendum) {
      chunkResult = addendum;
      chunkerVersion = "addendum-v1";
      addendumChunkingMode = "specialized";
      // Diagnostics describe Docling chunk coverage, which no longer applies.
      parserDiagnostics = null;
    } else {
      // A Docling fallback keeps its own chunks and chunker version.
      if (!parserDiagnostics) chunkerVersion = "semantic-addendum-fallback-v1";
      addendumChunkingMode = "semantic_fallback";
      addendumFallbackReason = hasRequiredMetadata ? "unpaired_provisions" : "incomplete_metadata";
    }
  }
  if (input.knowledgeScope.sourceCollection === "mirae_sif") {
    chunkResult = removeDisposableSifChunks(chunkResult, parsed.source.filename);
  }
  if (chunkResult.chunks.length === 0) {
    throw deterministicChunkError("EMPTY_CANDIDATE_SET", "No relevant content was extracted from the parsed artifact.");
  }

  // A Docling factsheet that covers several funds must not stamp its cover fund, strategy and
  // scheme category on every chunk. Each chunk keeps only its own fund (from the mapper); strategy,
  // canonical name, scheme category and scheme type are then derived per chunk, or null when the
  // chunk names no fund. Single-fund documents (one distinct fund), the unpdf path, HTML, FAQ and
  // addenda keep the shared document-level metadata unchanged.
  const multiFundDocument = parserDiagnostics !== null
    && distinctFundCount(chunkResult.chunks) >= 2;

  const documentFundName = multiFundDocument ? null : metadata.fundName;
  const documentScope = classifyDocumentScope({
    filename: parsed.source.filename,
    documentType: metadata.docType,
    sourceCollection: input.knowledgeScope.sourceCollection,
    fundName: documentFundName,
  });
  const sourceAuthority = metadata.docType === "Addendum"
    ? "regulatory_filing" as const
    : sourceUrl
      ? "official_product_page" as const
      : "unknown" as const;
  const citation = input.citationMetadata ?? {};
  if (multiFundDocument) {
    // Derive strategy, canonical name, scheme category and scheme type per chunk from its own fund
    // so the merge in `toCandidate` overrides the (now null) document-level values.
    for (const chunk of chunkResult.chunks) {
      chunk.metadata = { ...chunk.metadata, ...perChunkFundMetadata(chunk.metadata?.fundName ?? null, {
        filename: parsed.source.filename,
        documentType: metadata.docType,
        sourceCollection: input.knowledgeScope.sourceCollection,
      }) };
    }
  }
  const prepared = prepareChunkReview({
    document: {
      id: input.sourceDocumentId,
      filename: parsed.source.filename,
      pageCount: parsed.diagnostics.pageCount,
    },
    chunks: chunkResult.chunks,
    metadata: {
      documentScope,
      strategyId: strategyIdForScope(documentScope, documentFundName),
      canonicalStrategyName: documentScope === "strategy" ? documentFundName : null,
      sourceAuthority,
      sourceCollection: input.knowledgeScope.sourceCollection,
      fundName: documentFundName,
      documentType: metadata.docType,
      amcName: citation.amcName || metadata.amcName,
      schemeType: multiFundDocument ? null : (citation.schemeType || metadata.schemeType),
      schemeCategory: multiFundDocument ? null : (citation.schemeCategory || metadata.schemeCategory),
      documentDate: metadata.documentDate?.toISOString().slice(0, 10) ?? null,
      effectiveDate: metadata.effectiveDate?.toISOString().slice(0, 10) ?? null,
      amendmentNumber: metadata.amendmentNumber,
      amendedDocumentTypes: metadata.amendedDocumentTypes,
      addendumChunkingMode,
      addendumFallbackReason,
      sebiSchemeId: citation.sebiSchemeId ?? "",
      sebiUrl: citation.sebiUrl ?? "",
      sourceUrl,
      sourceChecksum: parsed.source.rawSha256,
      knowledgeDomain: input.knowledgeScope.knowledgeDomain,
      amcSlug: input.knowledgeScope.amcSlug,
      // Shared by every candidate so document-level findings survive manual-edit reinspection.
      ...(parserDiagnostics ? { parserDiagnostics } : {}),
    },
    ownership: input.ownership,
  });
  if (prepared.report.inspectedChunkCount !== chunkResult.chunks.length) {
    throw deterministicChunkError("INCOMPLETE_INSPECTION", "Every chunk candidate must be inspected before review staging.");
  }
  return {
    metadata,
    knowledgeScope: input.knowledgeScope,
    chunkResult,
    chunkerVersion,
    prepared,
    sourceAuthority,
  };
}

function isDoclingArtifact(parsed: PdfParseArtifact): parsed is DoclingPdfParseArtifact {
  return "kind" in parsed.parser && parsed.parser.kind === "docling";
}

/** Distinct non-empty fund names the Docling mapper stamped across the document's chunks. */
function distinctFundCount(chunks: ChunkResult["chunks"]): number {
  const funds = new Set<string>();
  for (const chunk of chunks) {
    const fundName = chunk.metadata?.fundName;
    if (fundName && fundName.trim()) funds.add(fundName.trim().toLowerCase());
  }
  return funds.size;
}

/**
 * Per-chunk scope, strategy, canonical name, scheme category and scheme type for a multi-fund
 * document, derived from the chunk's own fund only. A chunk that names no fund gets nulls. Scheme
 * category and type reuse the content extractors (no new classifier); they read the fund name,
 * which is the only text reliably about this chunk's fund.
 */
function perChunkFundMetadata(
  fundName: string | null,
  document: { filename: string; documentType: string | null; sourceCollection: string },
): Partial<CandidateChunkMetadata> {
  const scope = classifyDocumentScope({
    filename: document.filename,
    documentType: document.documentType,
    sourceCollection: document.sourceCollection,
    fundName,
  });
  return {
    documentScope: scope,
    strategyId: strategyIdForScope(scope, fundName),
    canonicalStrategyName: scope === "strategy" ? fundName : null,
    schemeCategory: fundName ? extractSchemeCategory(fundName) : null,
    schemeType: fundName ? extractSchemeType(fundName) : null,
  };
}

function sanitizePostgresText<T extends PdfParseArtifact>(parsed: T): T;
function sanitizePostgresText(parsed: PdfParseArtifact): PdfParseArtifact {
  const withoutNul = (value: string) => value.replaceAll("\u0000", "");
  if (isDoclingArtifact(parsed)) {
    return {
      ...parsed,
      pages: parsed.pages.map((page) => ({ ...page, text: withoutNul(page.text) })),
      chunks: parsed.chunks.map((chunk) => ({
        ...chunk,
        text: withoutNul(chunk.text),
        headings: chunk.headings.map(withoutNul),
      })),
    };
  }
  return {
    ...parsed,
    pages: parsed.pages.map((page) => ({ ...page, text: withoutNul(page.text) })),
    tables: parsed.tables.map((table) => ({
      ...table,
      rows: table.rows.map((row) => row.map(withoutNul)),
      markdown: withoutNul(table.markdown),
    })),
  };
}

export function extractPdfMetadata(
  parsed: Pick<PdfParseArtifact, "pages" | "source">,
  metadataFilepath?: string,
  documentType?: SourceDocumentType,
): ExtractedMetadata {
  const firstPagesText = parsed.pages.slice(0, 3).map((page) => page.text).join("\n\n");
  const rawText = parsed.pages
    .filter((page) => page.text.trim())
    .map((page) => `--- Page ${page.pageNumber} ---\n${page.text}`)
    .join("\n\n");
  return extractMetadata({
    filename: parsed.source.filename,
    filepath: metadataFilepath,
    firstPageText: firstPagesText,
    fullText: rawText,
    documentTypeOverride: documentType,
  });
}

function ownershipFromTrustedContext(context: TrustedPdfPipelineContext): ClassifiedKnowledgeOwnership {
  const ownership: ClassifiedKnowledgeOwnership = {
    visibilityScope: "TENANT",
    tenantId: context.externalCode,
    ownershipManifestId: `source-registry:${context.configRevisionId}`,
    ownershipManifestVersion: 1,
  };
  assertClassifiedKnowledgeOwnership(ownership);
  return ownership;
}

function assertTrustedContext(context: TrustedPdfPipelineContext, expectedAccessScopeId: string): void {
  if (context.accessScopeId !== expectedAccessScopeId
    || !context.accessScopeKey.trim()
    || !/^\d{1,20}$/.test(context.externalCode)
    || !context.configRevisionId.trim()
    || !SHA256_PATTERN.test(context.configRevisionChecksum)
    || !context.classification.knowledgeDomain
    || !context.classification.sourceCollection) {
    throw deterministicChunkError("OWNERSHIP_CONTEXT_MISMATCH", "Trusted access-scope and immutable registry context do not match the stage envelope.");
  }
}

function assertScheduledSourceUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch {
    throw deterministicChunkError("INVALID_SOURCE_PROVENANCE", "Scheduled parsed artifact has an invalid canonical URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw deterministicChunkError("INVALID_SOURCE_PROVENANCE", "Scheduled parsed artifact requires a credential-free HTTP(S) canonical URL.");
  }
}

function inspectedCandidateChecksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicChunkError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
