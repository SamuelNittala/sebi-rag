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
export type DocumentScope = "strategy" | "sif_umbrella" | "amc" | "regulatory" | "unknown";

export interface CandidateChunkMetadata {
  documentScope: DocumentScope;
  strategyId?: string | null;
  sectionType?: string | null;
  factType?: string | null;
  sourceCollection?: string | null;
  fundName?: string | null;
  documentType?: string | null;
  sourceUrl?: string | null;
  [key: string]: unknown;
}
