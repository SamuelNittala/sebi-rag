import type {
  CandidateChunkMetadata,
  ChunkFlagSeverity,
  VisibilityScope,
} from "@mf-rag/types";

export interface InspectionCandidate {
  id: string;
  chunkIndex: number;
  text: string;
  pageNumbers: number[];
  tokenCount: number;
  hasTable: boolean;
  sectionHeader: string | null;
  metadata: CandidateChunkMetadata;
}

export interface InspectionFinding {
  candidateId: string | null;
  chunkIndex: number | null;
  ruleCode: string;
  severity: ChunkFlagSeverity;
  blocksApproval: boolean;
  message: string;
  evidence: Record<string, unknown>;
}

export interface InspectionDocument {
  id: string;
  filename: string;
  pageCount: number | null;
  pageNumberBase?: 0 | 1;
}

export interface InspectionInput {
  document: InspectionDocument;
  candidates: InspectionCandidate[];
  ownership?: {
    visibilityScope: VisibilityScope;
    tenantId: string | null;
  };
}

export interface InspectionReport {
  inspectorVersion: string;
  candidateChunkCount: number;
  inspectedChunkCount: number;
  findings: InspectionFinding[];
  criticalCount: number;
  warningCount: number;
  blockingCount: number;
}

export interface ChunkInspectorConfig {
  inspectorVersion: string;
  maxTextTokens: number;
  maxTableTokens: number;
  headingOnlyMaxTokens: number;
}

export interface ChunkInspectorContract {
  inspect(input: InspectionInput): InspectionReport;
}

export interface EditableInspectionCandidate extends InspectionCandidate {
  contentHash: string;
}

export interface PrepareManualChunkEditInput {
  document: InspectionDocument;
  ownership?: InspectionInput["ownership"];
  candidates: EditableInspectionCandidate[];
  candidateId: string;
  expectedContentHash: string;
  text: string;
}

export interface PreparedManualChunkEdit {
  candidateId: string;
  text: string;
  tokenCount: number;
  beforeContentHash: string;
  afterContentHash: string;
  metadata: CandidateChunkMetadata;
  report: InspectionReport;
}
