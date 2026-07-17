export const reviewRunStatuses = [
  "parsed",
  "inspecting",
  "review_ready",
  "approved",
  "rejected",
  "embedding",
  "staged",
  "published",
  "failed",
] as const;

export type ReviewRunStatus = (typeof reviewRunStatuses)[number];

export const chunkFlagSeverities = ["critical", "warning", "info"] as const;
export type ChunkFlagSeverity = (typeof chunkFlagSeverities)[number];

export const chunkFlagStatuses = ["open", "accepted", "resolved"] as const;
export type ChunkFlagStatus = (typeof chunkFlagStatuses)[number];

export type ReviewSourceType = "pdf" | "html";
export type ReviewPurpose = "content" | "metadata";
export type DocumentScope = "strategy" | "sif_umbrella" | "amc" | "regulatory" | "unknown";

export interface CandidateChunkMetadata {
  documentScope: DocumentScope;
  sourceChunkId?: string;
  strategyId?: string | null;
  canonicalStrategyName?: string | null;
  sourceAuthority?: "regulatory_filing" | "official_product_page" | "marketing" | "unknown";
  sectionType?: string | null;
  factType?: string | null;
  confidence?: number;
  classificationSource?: "document_manifest" | "exact_heading" | "body_evidence" | "human";
  evidence?: string[];
  sourceCollection?: string | null;
  fundName?: string | null;
  documentType?: string | null;
  sourceUrl?: string | null;
  [key: string]: unknown;
}
