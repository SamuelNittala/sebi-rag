import {
  and,
  eq,
  ingestionRuns,
  stageAttempts,
  type Database,
} from "@mf-rag/db";

import type { StageHandlerContext, StageHandlerResult } from "../runtime/stage-registry.ts";

export interface ScheduledDocumentPublisher {
  publish(input: {
    readonly reviewRunId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly generationId: string; readonly outputChecksum: string }>;
}

export interface PublishDocumentRepository {
  loadApprovedReviewRunId(context: StageHandlerContext): Promise<string>;
}

export class PublishDocumentStage {
  constructor(private readonly options: {
    readonly repository: PublishDocumentRepository;
    readonly publisher: ScheduledDocumentPublisher;
  }) {}

  async execute(context: StageHandlerContext): Promise<StageHandlerResult> {
    const reviewRunId = await this.options.repository.loadApprovedReviewRunId(context);
    const result = await this.options.publisher.publish({ reviewRunId, signal: context.signal });
    return {
      outputRef: `publication-generation:${result.generationId}`,
      outputChecksum: result.outputChecksum,
    };
  }
}

export function createDatabasePublishDocumentRepository(db: Database): PublishDocumentRepository {
  return {
    async loadApprovedReviewRunId(context) {
      const [riskAttempt] = await db.select({ outputRef: stageAttempts.outputRef }).from(stageAttempts).where(and(
        eq(stageAttempts.pipelineRunId, context.pipelineRunId),
        eq(stageAttempts.documentVersionId, context.documentVersionId),
        eq(stageAttempts.stage, "REVIEW_DECISION"),
        eq(stageAttempts.outputChecksum, context.inputChecksum),
        eq(stageAttempts.status, "succeeded"),
      )).limit(1);
      const match = riskAttempt?.outputRef?.match(/^risk-decision:([0-9a-f-]{36})$/i);
      if (!match?.[1]) throw deterministicError("RISK_DECISION_NOT_FOUND", "No compatible risk decision exists for publication.");
      const [run] = await db.select({ status: ingestionRuns.status }).from(ingestionRuns)
        .where(eq(ingestionRuns.id, match[1])).limit(1);
      if (run?.status !== "approved" && run?.status !== "failed") {
        throw deterministicError("REVIEW_NOT_APPROVED", "Exact scheduled review approval is required before publication.");
      }
      return match[1];
    },
  };
}

function deterministicError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
