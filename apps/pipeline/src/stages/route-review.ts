import { createHash } from "node:crypto";

import { DocumentRiskPolicy, type DocumentRiskEvidence } from "@mf-rag/core/chunk-inspection";
import {
  and,
  eq,
  getScheduledReviewRiskContext,
  persistScheduledRiskDecision,
  stageAttempts,
  type Database,
  type PersistScheduledRiskDecisionInput,
} from "@mf-rag/db";

import type { StageHandlerContext, StageHandlerResult } from "../runtime/stage-registry.ts";

export interface RouteReviewRepository {
  loadReviewRunId(context: StageHandlerContext): Promise<string>;
  loadRiskContext(runId: string): ReturnType<typeof getScheduledReviewRiskContext>;
  persist(input: PersistScheduledRiskDecisionInput): Promise<{ readonly id: string }>;
}

/** Risk routing is deterministic; a human route pauses the pipeline after next work is durably created. */
export class RouteReviewStage {
  constructor(private readonly options: {
    readonly repository: RouteReviewRepository;
    readonly policy?: DocumentRiskPolicy;
    readonly actor?: string;
  }) {}

  async execute(context: StageHandlerContext): Promise<StageHandlerResult> {
    const reviewRunId = await this.options.repository.loadReviewRunId(context);
    const riskContext = await this.options.repository.loadRiskContext(reviewRunId);
    const run = riskContext.run;
    if (run.pipelineRunId !== context.pipelineRunId || run.documentVersionId !== context.documentVersionId) {
      throw deterministicError("REVIEW_LINEAGE_MISMATCH", "Review run does not belong to the claimed pipeline version.");
    }
    const previous = riskContext.previousPublication;
    const evidence: DocumentRiskEvidence = {
      isFirstVersion: riskContext.isFirstVersion,
      candidateChunkCount: run.candidateChunkCount,
      inspectedChunkCount: run.inspectedChunkCount,
      openBlockingCount: run.blockingCount,
      openWarningCount: run.warningCount,
      extractionAnomaly: run.criticalCount > 0,
      ownershipDrift: Boolean(previous) && (
        previous!.visibilityScope !== run.visibilityScope
        || previous!.tenantId !== run.tenantId
        || previous!.ownershipManifestId !== run.ownershipManifestId
        || previous!.ownershipManifestVersion !== run.ownershipManifestVersion
      ),
      configRevisionDrift: Boolean(previous) && previous!.configRevisionId !== run.configRevisionId,
      parserVersionDrift: Boolean(previous) && previous!.parserVersion !== run.parserVersion,
      chunkerVersionDrift: Boolean(previous) && previous!.chunkerVersion !== run.chunkerVersion,
      inspectorVersionDrift: Boolean(previous) && previous!.inspectorVersion !== run.inspectorVersion,
    };
    const decision = (this.options.policy ?? new DocumentRiskPolicy()).evaluate(evidence);
    const actor = this.options.actor ?? "system:risk-policy";
    await this.options.repository.persist({
      runId: run.id,
      policyVersion: decision.policyVersion,
      classification: decision.classification,
      route: decision.route,
      reasonCodes: decision.reasonCodes,
      evidence: decision.evidence,
      actor,
    });
    const outputChecksum = createHash("sha256").update(JSON.stringify({
      reviewRunId: run.id,
      documentVersionId: context.documentVersionId,
      policyVersion: decision.policyVersion,
      classification: decision.classification,
      route: decision.route,
      reasonCodes: decision.reasonCodes,
      evidence: decision.evidence,
    })).digest("hex");
    return { outputRef: `risk-decision:${run.id}`, outputChecksum };
  }
}

export function createDatabaseRouteReviewRepository(db: Database): RouteReviewRepository {
  return {
    async loadReviewRunId(context) {
      const [attempt] = await db.select({ outputRef: stageAttempts.outputRef }).from(stageAttempts).where(and(
        eq(stageAttempts.pipelineRunId, context.pipelineRunId),
        eq(stageAttempts.documentVersionId, context.documentVersionId),
        eq(stageAttempts.stage, "CHUNK_AND_INSPECT"),
        eq(stageAttempts.outputChecksum, context.inputChecksum),
        eq(stageAttempts.status, "succeeded"),
      )).limit(1);
      const match = attempt?.outputRef?.match(/^review:([0-9a-f-]{36})$/i);
      if (!match?.[1]) throw deterministicError("REVIEW_OUTPUT_NOT_FOUND", "No compatible inspected review output exists.");
      return match[1];
    },
    loadRiskContext: (runId) => getScheduledReviewRiskContext(db, runId),
    persist: (input) => persistScheduledRiskDecision(db, input),
  };
}

function deterministicError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
