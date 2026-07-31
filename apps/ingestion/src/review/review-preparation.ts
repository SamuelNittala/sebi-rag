import { createHash } from "node:crypto";

import {
  ChunkInspector,
  type InspectionCandidate,
  type InspectionDocument,
  type InspectionReport,
} from "@mf-rag/core/chunk-inspection";
import type { CandidateChunkMetadata } from "@mf-rag/types";
import { classifySection } from "./review-metadata.ts";

interface ReviewableChunk {
  text: string;
  chunkIndex: number;
  pageNumbers: number[];
  hasTable: boolean;
  sectionHeader: string | null;
  tokenCount: number;
  metadata?: Partial<CandidateChunkMetadata>;
}

export interface ReviewCandidate extends InspectionCandidate {
  contentHash: string;
}

export interface PrepareChunkReviewInput {
  document: InspectionDocument;
  chunks: ReviewableChunk[];
  metadata: CandidateChunkMetadata;
  ownership?: {
    visibilityScope: "GLOBAL" | "TENANT" | "UNCLASSIFIED";
    tenantId: string | null;
  };
}

export interface PreparedChunkReview {
  candidates: ReviewCandidate[];
  report: InspectionReport;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuidFromHash(hash: string): string {
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function toCandidate(
  documentId: string,
  chunk: ReviewableChunk,
  metadata: CandidateChunkMetadata,
): ReviewCandidate {
  const contentHash = sha256(chunk.text);
  const identityHash = sha256(`${documentId}:${chunk.chunkIndex}:${contentHash}`);
  const section = classifySection(chunk.sectionHeader, metadata.documentScope);
  return {
    id: uuidFromHash(identityHash),
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    pageNumbers: chunk.pageNumbers,
    tokenCount: chunk.tokenCount,
    hasTable: chunk.hasTable,
    sectionHeader: chunk.sectionHeader,
    metadata: { ...metadata, ...chunk.metadata, ...section },
    contentHash,
  };
}

export function prepareChunkReview(input: PrepareChunkReviewInput): PreparedChunkReview {
  const candidates = input.chunks.map((chunk) =>
    toCandidate(input.document.id, chunk, input.metadata)
  );
  const report = new ChunkInspector().inspect({
    document: input.document,
    candidates,
    ownership: input.ownership,
  });
  return { candidates, report };
}
