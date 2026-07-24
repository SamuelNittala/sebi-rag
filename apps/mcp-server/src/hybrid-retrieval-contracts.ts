import type { CandidateChunkMetadata, SupersessionKey } from "@mf-rag/types";

export type RetrievalSourceType = "scheme_document" | "knowledge_base";

export type RetrievalFactIntent =
  | "fund_manager"
  | "investment_objective"
  | "investment_strategy"
  | "investment_approach"
  | "risk"
  | "benchmark"
  | "minimum_investment"
  | "exit_load"
  | "expenses"
  | "redemption"
  | "eligibility";

export interface RetrievalIntent {
  factType: RetrievalFactIntent | null;
  strategyId: string | null;
  preferredDocumentScope: "strategy" | "sif_umbrella" | null;
  supersessionKey?: SupersessionKey;
}

export interface HybridRetrievalCandidate {
  id: string;
  sourceType: RetrievalSourceType;
  metadata: CandidateChunkMetadata | null;
  text?: string;
  fundName?: string;
  documentFilename?: string;
  documentTitle?: string;
}

export interface RankedRetrievalCandidate<T extends HybridRetrievalCandidate> {
  candidate: T;
  score: number;
}

export interface RetrievalTrace {
  denseRank: number | null;
  denseScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
  rrfScore: number;
  metadataAdjustment: number;
  metadataSignals: string[];
  fusedScore: number;
  preRerankRank: number;
  rerankRank: number | null;
  rerankScore: number | null;
  finalScore: number;
}

export interface FusedRetrievalCandidate<T extends HybridRetrievalCandidate> {
  candidate: T;
  trace: RetrievalTrace;
}

export interface HybridFusionInput<T extends HybridRetrievalCandidate> {
  dense: Array<RankedRetrievalCandidate<T>>;
  lexical: Array<RankedRetrievalCandidate<T>>;
  intent: RetrievalIntent;
  limit: number;
  rrfK?: number;
  asOfDate?: string;
}
