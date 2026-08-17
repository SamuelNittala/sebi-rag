import { createHash } from "node:crypto";

import type {
  ArtifactDescriptor,
  ClassifiedKnowledgeOwnership,
  KnowledgeScope,
} from "@mf-rag/types";
import { assertClassifiedKnowledgeOwnership } from "@mf-rag/types";
import type { StageInspectionReviewInput } from "@mf-rag/db";

import { chunkAddendum } from "../chunkers/addendum-chunker.ts";
import { removeDisposableSifChunks } from "../chunkers/disposable-content.ts";
import {
  semanticChunk,
  type ChunkResult,
} from "../chunkers/semantic-chunker.ts";
import {
  extractMetadata,
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
  decodeNormalizedParseArtifact,
  parsedPdfMediaType,
  type NormalizedPdfParseArtifact,
  type PdfStageArtifactStore,
} from "./parse-pdf-stage.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
    if (input.parsedArtifact.mediaType !== parsedPdfMediaType()) {
      throw deterministicChunkError("INVALID_PARSED_MEDIA_TYPE", "Chunk stage accepts only the normalized PDF artifact contract.");
    }
    input.signal?.throwIfAborted();
    const bytes = await this.options.artifactStore.readVerified(input.parsedArtifact);
    if (sha256Hex(bytes) !== input.parsedArtifact.sha256 || bytes.byteLength !== input.parsedArtifact.byteSize) {
      throw deterministicChunkError("PARSED_ARTIFACT_CHECKSUM_MISMATCH", "Parsed artifact bytes failed integrity verification.");
    }
    const parsed = decodeNormalizedParseArtifact(bytes);
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
  readonly parsed: NormalizedPdfParseArtifact;
  readonly sourceDocumentId: string;
  readonly ownership: ClassifiedKnowledgeOwnership;
  readonly knowledgeScope: KnowledgeScope;
  readonly citationMetadata?: PdfCitationMetadata;
  /** Legacy-only hint; scheduled artifacts never depend on a local path. */
  readonly metadataFilepath?: string;
  readonly metadata?: ExtractedMetadata;
  /** Legacy/manual citation override; omitted by scheduled workers. */
  readonly sourceUrl?: string | null;
}): PreparedPdfChunkInspection {
  assertClassifiedKnowledgeOwnership(input.ownership);
  const parsed = input.parsed;
  const sourceUrl = input.sourceUrl === undefined ? parsed.source.canonicalUrl : input.sourceUrl;
  const metadata = input.metadata ?? extractPdfMetadata(parsed, input.metadataFilepath);
  let chunkResult = semanticChunk({
    pages: parsed.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text })),
    tables: parsed.tables.map((table) => ({ pageNumber: table.pageNumber, markdown: table.markdown })),
  });
  let chunkerVersion = "semantic-v1";
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
    } else {
      chunkerVersion = "semantic-addendum-fallback-v1";
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

  const documentScope = classifyDocumentScope({
    filename: parsed.source.filename,
    documentType: metadata.docType,
    sourceCollection: input.knowledgeScope.sourceCollection,
    fundName: metadata.fundName,
  });
  const sourceAuthority = metadata.docType === "Addendum"
    ? "regulatory_filing" as const
    : sourceUrl
      ? "official_product_page" as const
      : "unknown" as const;
  const citation = input.citationMetadata ?? {};
  const prepared = prepareChunkReview({
    document: {
      id: input.sourceDocumentId,
      filename: parsed.source.filename,
      pageCount: parsed.diagnostics.pageCount,
    },
    chunks: chunkResult.chunks,
    metadata: {
      documentScope,
      strategyId: strategyIdForScope(documentScope, metadata.fundName),
      canonicalStrategyName: documentScope === "strategy" ? metadata.fundName : null,
      sourceAuthority,
      sourceCollection: input.knowledgeScope.sourceCollection,
      fundName: metadata.fundName,
      documentType: metadata.docType,
      amcName: citation.amcName || metadata.amcName,
      schemeType: citation.schemeType || metadata.schemeType,
      schemeCategory: citation.schemeCategory || metadata.schemeCategory,
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

export function extractPdfMetadata(
  parsed: NormalizedPdfParseArtifact,
  metadataFilepath?: string,
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
