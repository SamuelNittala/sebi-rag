import type { AccessScopeKey } from "./source-registry.ts";

declare const documentVersionIdBrand: unique symbol;
declare const pipelineRunIdBrand: unique symbol;
declare const stageAttemptIdBrand: unique symbol;

export type DocumentVersionId = string & { readonly [documentVersionIdBrand]: true };
export type PipelineRunId = string & { readonly [pipelineRunIdBrand]: true };
export type StageAttemptId = string & { readonly [stageAttemptIdBrand]: true };

export const pipelineStages = [
  "DISCOVER",
  "FETCH",
  "PARSE",
  "CHUNK_AND_INSPECT",
  "REVIEW_DECISION",
  "EMBED_AND_PUBLISH",
] as const;
export type PipelineStage = (typeof pipelineStages)[number];

export const sourceAcquisitionStages = ["DISCOVER", "FETCH"] as const;
export type SourceAcquisitionStage = (typeof sourceAcquisitionStages)[number];

export const documentPipelineStages = [
  "PARSE",
  "CHUNK_AND_INSPECT",
  "REVIEW_DECISION",
  "EMBED_AND_PUBLISH",
] as const;
export type DocumentPipelineStage = (typeof documentPipelineStages)[number];

export const stageOutcomes = ["SUCCEEDED", "FAILED", "WAITING_REVIEW"] as const;
export type StageOutcome = (typeof stageOutcomes)[number];

export interface ArtifactDescriptor {
  readonly key: string;
  readonly uri: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly producerVersion: string;
}

export interface PipelineStageResult {
  readonly stageAttemptId: StageAttemptId;
  readonly pipelineRunId: PipelineRunId;
  readonly documentVersionId: DocumentVersionId;
  readonly accessScopeKey: AccessScopeKey;
  readonly stage: DocumentPipelineStage;
  readonly implementationVersion: string;
  readonly inputChecksum: string;
  readonly outputRef: string | null;
  readonly outcome: StageOutcome;
}

export function createDocumentVersionId(value: string): DocumentVersionId {
  return createOpaqueId(value, "Document version ID") as DocumentVersionId;
}

export function createPipelineRunId(value: string): PipelineRunId {
  return createOpaqueId(value, "Pipeline run ID") as PipelineRunId;
}

export function createStageAttemptId(value: string): StageAttemptId {
  return createOpaqueId(value, "Stage attempt ID") as StageAttemptId;
}

function createOpaqueId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a canonical 1-128 character identifier.`);
  }
  return value;
}
