import type { DocumentScope, ReviewSourceType } from "@mf-rag/types";

export const miraeSifSectionTypes = [
  "investment_objective",
  "investment_strategy",
  "investment_approach",
  "strategy_management",
  "staff_directory",
  "risk",
  "benchmark",
  "minimum_investment",
  "exit_load",
  "expenses",
  "redemption",
  "eligibility",
  "fund_facts",
  "overview",
  "unknown",
] as const;

export const miraeSifStrategies = [{
  id: "platinum-hybrid-long-short-fund",
  name: "Platinum Hybrid Long-Short Fund",
  aliases: [
    "platinum",
    "platinum sif",
    "platinum hybrid fund",
    "platinum hybrid long-short fund",
    "platinum hybrid long short fund",
    "platinum long-short",
    "platinum long short",
    "hybrid long-short",
    "hybrid long short",
  ],
}] as const;

export const miraeSifUmbrellaAliases = [
  "sif",
  "sifs",
  "mirae sif",
  "platinum",
  "platinum sif",
  "specialized investment fund",
  "specialized investment funds",
] as const;

export type MiraeSifSectionType = (typeof miraeSifSectionTypes)[number];
export type MiraeSifFactType = Exclude<MiraeSifSectionType,
  "strategy_management" | "staff_directory" | "fund_facts" | "overview" | "unknown"
> | "fund_manager";

export interface MiraeSifDocumentIdentity {
  documentScope: DocumentScope;
  strategyId: string | null;
  canonicalStrategyName: string | null;
  sourceAuthority: "regulatory_filing" | "official_product_page" | "marketing" | "unknown";
}

export interface MiraeSifSourceDocument {
  sourceType: ReviewSourceType;
  sourceDocumentId: string;
  sourceName: string;
  sourceLocation: string | null;
}

export interface MiraeSifSourceChunk {
  id: string;
  chunkIndex: number;
  text: string;
  pageNumbers: number[];
  hasTable: boolean;
  sectionHeader: string | null;
}

export interface MiraeSifMetadataProposal extends MiraeSifDocumentIdentity, Record<string, unknown> {
  sourceChunkId: string;
  sectionType: MiraeSifSectionType;
  factType: MiraeSifFactType | null;
  confidence: number;
  classificationSource: "document_manifest" | "exact_heading" | "body_evidence" | "human";
  evidence: string[];
}

export interface MetadataReviewFinding {
  candidateId: string | null;
  chunkIndex: number | null;
  ruleCode: string;
  severity: "critical" | "warning" | "info";
  blocksApproval: boolean;
  message: string;
  evidence: Record<string, unknown>;
}

export interface PreparedMetadataReview {
  candidates: Array<{
    id: string;
    chunkIndex: number;
    text: string;
    pageNumbers: number[];
    tokenCount: number;
    hasTable: boolean;
    sectionHeader: string | null;
    metadata: MiraeSifMetadataProposal & Record<string, unknown>;
    contentHash: string;
  }>;
  findings: MetadataReviewFinding[];
}
