import type { ChunkPayload } from "./chunk.ts";

export interface Citation {
  index: number;
  documentId: string;
  documentFilename: string;
  fundName: string;
  docType: string;
  pageNumbers: number[];
  textSnippet: string;
  relevanceScore: number;
  /** SEBI scheme detail page URL for verification */
  sebiUrl?: string;
}

/** Detected fund information from query. */
export interface DetectedFund {
  /** Fund name that was detected */
  fundName: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Whether filter was auto-applied */
  autoApplied: boolean;
}

export interface QueryMetadata {
  queryTimeMs: number;
  chunksRetrieved: number;
  chunksUsed: number;
  model: string;
  /** Detected fund information if fund detection was used */
  detectedFund?: DetectedFund;
  /** Detected AMC filter if AMC-level query was detected */
  detectedAmc?: string;
  /** Multiple fund matches when query is ambiguous */
  ambiguousMatches?: DetectedFund[];
  /** True if user should clarify which fund they mean */
  clarificationNeeded?: boolean;
  /** True if response was rejected by output validator */
  validationFailed?: boolean;
  /** Reason for validation failure */
  validationReason?: string;
}

export interface QueryResponse {
  answer: string;
  citations: Citation[];
  metadata: QueryMetadata;
}

export interface SearchResult {
  chunkId: string;
  text: string;
  score: number;
  metadata: ChunkPayload;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface DocumentListResponse {
  documents: Array<{
    id: string;
    filename: string;
    status: string;
    chunkCount: number;
    createdAt: Date;
  }>;
  total: number;
}

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  services: {
    vector: boolean;
    postgres: boolean;
    ollama: boolean;
  };
}
