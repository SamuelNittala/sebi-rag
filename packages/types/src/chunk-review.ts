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
export type SupersessionKey =
  | "accredited_minimum_application"
  | "minimum_sip_installment"
  | "minimum_swp_withdrawal"
  | "exit_load_window";

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
  documentDate?: string | null;
  /** Generic PDF identity. Scheme documents may leave these unset. */
  documentKind?: "scheme" | "FAQ" | "generic_pdf";
  documentTitle?: string | null;
  publisher?: string | null;
  authority?: "regulator" | "sebi_established_institute" | "issuer" | "unknown";
  sourceDate?: string | null;
  sourceChecksum?: string | null;
  sourceProfile?: string | null;
  /** FAQ identity and governance fields. */
  topic?: string | null;
  questionNumber?: string | null;
  normalizedQuestionKey?: string | null;
  originalQuestion?: string | null;
  answer?: string | null;
  continuationIndex?: number;
  firstPage?: number;
  lastPage?: number;
  sourceCoverageComplete?: boolean;
  intentionalDuplicateDisposition?: "retain_distinct_authority" | "replace";
  effectiveDate?: string | null;
  amendmentNumber?: string | null;
  amendedDocumentTypes?: string[];
  supersessionKey?: SupersessionKey | null;
  [key: string]: unknown;
}
