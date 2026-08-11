import { documentPipelineStages, type DocumentPipelineStage } from "@mf-rag/types";
import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface StageHandlerContext {
  readonly pipelineRunId: string;
  readonly documentVersionId: string;
  readonly accessScopeId: string;
  readonly sourceId: string;
  readonly inputChecksum: string;
  readonly signal: AbortSignal;
}

export interface StageHandlerResult {
  readonly outputRef: string;
  readonly outputChecksum: string;
}

export interface StageImplementationIdentityInput {
  readonly configChecksum: string;
}

export interface StageRegistrationInput {
  readonly stage: DocumentPipelineStage;
  readonly implementationIdentity: StageImplementationIdentityInput;
  readonly handler: (context: StageHandlerContext) => Promise<StageHandlerResult>;
}

export interface StageRegistration extends Omit<StageRegistrationInput, "implementationIdentity"> {
  readonly implementationVersion: string;
}

/** Compatibility changes automatically when configuration changes. */
export function deriveStageImplementationVersion(input: StageImplementationIdentityInput): string {
  if (!SHA256_PATTERN.test(input.configChecksum)) {
    throw new Error("Stage configuration checksum must be a lowercase SHA-256 value.");
  }
  const digest = createHash("sha256").update(JSON.stringify([
    "mf-rag-stage-implementation-v1",
    input.configChecksum,
  ])).digest("hex");
  return `stage-v1:${digest}`;
}

/** Validated registry of disabled-by-default stage adapters and their fixed order. */
export class StageRegistry {
  private readonly registrations = new Map<DocumentPipelineStage, StageRegistration>();

  constructor(registrations: readonly StageRegistrationInput[]) {
    for (const input of registrations) {
      if (this.registrations.has(input.stage)) {
        throw new Error(`Stage ${input.stage} is registered more than once.`);
      }
      this.registrations.set(input.stage, {
        stage: input.stage,
        implementationVersion: deriveStageImplementationVersion(input.implementationIdentity),
        handler: input.handler,
      });
    }
  }

  get(stage: DocumentPipelineStage): StageRegistration {
    const registration = this.registrations.get(stage);
    if (!registration) throw new Error(`Stage ${stage} is not enabled in this worker.`);
    return registration;
  }

  next(stage: DocumentPipelineStage): StageRegistration | null {
    const position = documentPipelineStages.indexOf(stage);
    const nextStage = documentPipelineStages[position + 1];
    if (!nextStage) return null;
    return this.get(nextStage);
  }
}
