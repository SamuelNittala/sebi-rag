import type { DocumentPipelineStage, PipelineFailureClassification } from "@mf-rag/types";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { Database } from "./client.ts";
import {
  documentVersions,
  discoveryRuns,
  accessScopes,
  pipelineRuns,
  sourceSchedules,
  sources,
  stageAttempts,
  type StageTerminalDisposition,
} from "./schema.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface EnqueueDocumentPipelineRunInput {
  readonly documentVersionId: string;
  readonly implementationVersion: string;
  readonly initialStage: DocumentPipelineStage;
  readonly initialStageImplementationVersion: string;
  readonly inputChecksum: string;
  readonly maxAttempts?: number;
  readonly now?: Date;
}

export interface EnqueuedDocumentPipelineRun {
  readonly run: typeof pipelineRuns.$inferSelect;
  readonly attempt: typeof stageAttempts.$inferSelect;
}

export interface ClaimStageAttemptsInput {
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface AttemptFence {
  readonly attemptId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface CompatibleStageIdentity {
  readonly documentVersionId: string;
  readonly stage: DocumentPipelineStage;
  readonly implementationVersion: string;
  readonly inputChecksum: string;
}

export interface NextStageInput {
  readonly stage: DocumentPipelineStage;
  readonly implementationVersion: string;
  readonly inputChecksum: string;
  readonly maxAttempts?: number;
}

export interface CompleteStageAttemptInput extends AttemptFence {
  readonly outputRef: string;
  readonly outputChecksum: string;
  readonly next?: NextStageInput;
  readonly now?: Date;
}

export interface CompleteStageAttemptResult {
  readonly accepted: boolean;
  readonly attempt: typeof stageAttempts.$inferSelect | null;
  readonly nextAttempt: typeof stageAttempts.$inferSelect | null;
}

export type FailureClassification = PipelineFailureClassification;

export interface FailStageAttemptInput extends AttemptFence {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly classification: FailureClassification;
  readonly retryDelayMs?: number;
  readonly now?: Date;
}

export interface FailStageAttemptResult {
  readonly accepted: boolean;
  readonly disposition: StageTerminalDisposition | null;
  readonly retryAttempt: typeof stageAttempts.$inferSelect | null;
}

export interface RequeueDeadLetterAttemptInput {
  readonly attemptId: string;
  readonly operator: string;
  readonly expectedInputChecksum: string;
  readonly expectedAccessScopeId: string;
  readonly expectedSourceId: string;
  readonly expectedDocumentVersionId: string;
  readonly now?: Date;
}

export type RequeueTerminalAttemptInput = RequeueDeadLetterAttemptInput;

export interface TriggerManualDiscoveryRunInput {
  readonly sourceId: string;
  readonly now?: Date;
}

export interface ClaimDiscoveryExecutionsInput {
  readonly owner: string;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
  readonly now?: Date;
}

export interface DiscoveryExecutionFence {
  readonly discoveryRunId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface FailDiscoveryExecutionInput extends DiscoveryExecutionFence {
  readonly classification: FailureClassification;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryDelayMs?: number;
  readonly now?: Date;
}

export interface ReuseCompatibleStageSuccessInput extends AttemptFence {
  readonly successfulAttemptId: string;
  readonly next?: NextStageInput;
  readonly now?: Date;
}

/** Create or reuse one version-owned workflow and its compatible first input. */
export async function enqueueDocumentPipelineRun(
  db: Database,
  input: EnqueueDocumentPipelineRunInput,
): Promise<EnqueuedDocumentPipelineRun> {
  assertNonEmpty(input.implementationVersion, "Pipeline implementation version");
  assertNonEmpty(input.initialStageImplementationVersion, "Initial stage implementation version");
  assertChecksum(input.inputChecksum, "Stage input checksum");
  const maxAttempts = positiveInteger(input.maxAttempts ?? 3, "Maximum attempts");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [version] = await tx.select().from(documentVersions)
      .where(eq(documentVersions.id, input.documentVersionId))
      .limit(1);
    if (!version) throw new Error("Document version does not exist.");

    const [insertedRun] = await tx.insert(pipelineRuns).values({
      documentVersionId: version.id,
      accessScopeId: version.accessScopeId,
      sourceId: version.sourceId,
      implementationVersion: input.implementationVersion,
      initialStage: input.initialStage,
      initialStageImplementationVersion: input.initialStageImplementationVersion,
      initialInputChecksum: input.inputChecksum,
      initialMaxAttempts: maxAttempts,
      status: "active",
    }).onConflictDoNothing({
      target: [pipelineRuns.documentVersionId, pipelineRuns.implementationVersion],
    }).returning();
    const run = insertedRun ?? (await tx.select().from(pipelineRuns).where(and(
      eq(pipelineRuns.documentVersionId, version.id),
      eq(pipelineRuns.implementationVersion, input.implementationVersion),
    )).limit(1))[0];
    if (!run) throw new Error("Failed to resolve pipeline run.");
    assertRunOwnership(run, version);
    if (run.initialStage !== input.initialStage
      || run.initialStageImplementationVersion !== input.initialStageImplementationVersion
      || run.initialInputChecksum !== input.inputChecksum
      || run.initialMaxAttempts !== maxAttempts) {
      throw new Error("Existing pipeline run initial stage contract does not match the requested input.");
    }

    const [existingInitial] = await tx.select().from(stageAttempts).where(and(
      eq(stageAttempts.pipelineRunId, run.id),
      eq(stageAttempts.stage, run.initialStage),
      eq(stageAttempts.isCurrent, true),
    )).limit(1);
    if (existingInitial) {
      if (existingInitial.implementationVersion !== input.initialStageImplementationVersion
        || existingInitial.inputChecksum !== input.inputChecksum
        || existingInitial.maxAttempts !== maxAttempts) {
        throw new Error("Existing pipeline run initial stage contract does not match the requested input.");
      }
      return { run, attempt: existingInitial };
    }

    const [insertedAttempt] = await tx.insert(stageAttempts).values({
      pipelineRunId: run.id,
      documentVersionId: run.documentVersionId,
      accessScopeId: run.accessScopeId,
      sourceId: run.sourceId,
      stage: input.initialStage,
      implementationVersion: input.initialStageImplementationVersion,
      inputChecksum: input.inputChecksum,
      maxAttempts,
      nextRunAt: now,
    }).onConflictDoNothing().returning();
    const attempt = insertedAttempt;
    if (!attempt) throw new Error("Failed to resolve initial stage attempt.");
    return { run, attempt };
  });
}

/**
 * Claim a small batch under row locks. The transaction ends before any stage
 * handler executes; an expired row is reclaimed by increasing its fence epoch.
 */
export async function claimStageAttempts(
  db: Database,
  input: ClaimStageAttemptsInput,
): Promise<Array<typeof stageAttempts.$inferSelect>> {
  assertNonEmpty(input.owner, "Lease owner");
  const batchSize = boundedPositiveInteger(input.batchSize, 100, "Claim batch size");
  const leaseDurationMs = positiveInteger(input.leaseDurationMs, "Lease duration");
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  return db.transaction(async (tx) => {
    const candidates = await tx.select({ attempt: stageAttempts })
      .from(stageAttempts)
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, stageAttempts.pipelineRunId))
      .innerJoin(sources, eq(sources.id, stageAttempts.sourceId))
      .innerJoin(accessScopes, eq(accessScopes.id, stageAttempts.accessScopeId))
      .where(and(
        eq(stageAttempts.isCurrent, true),
        eq(pipelineRuns.status, "active"),
        isNull(pipelineRuns.pausedAt),
        isNull(sources.emergencyFrozenAt),
        isNull(accessScopes.emergencyFrozenAt),
        or(
          and(
            inArray(stageAttempts.status, ["pending", "retry_wait"]),
            lte(stageAttempts.nextRunAt, now),
          ),
          and(
            eq(stageAttempts.status, "running"),
            lte(stageAttempts.leaseExpiresAt, now),
          ),
        ),
      ))
      .orderBy(asc(stageAttempts.nextRunAt), asc(stageAttempts.createdAt), asc(stageAttempts.id))
      .limit(batchSize)
      .for("update", { of: stageAttempts, skipLocked: true });

    const claimed: Array<typeof stageAttempts.$inferSelect> = [];
    for (const { attempt } of candidates) {
      const [updated] = await tx.update(stageAttempts).set({
        status: "running",
        leaseOwner: input.owner,
        leaseEpoch: sql`${stageAttempts.leaseEpoch} + 1`,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: attempt.startedAt ?? now,
        updatedAt: now,
      }).where(and(
        eq(stageAttempts.id, attempt.id),
        eq(stageAttempts.isCurrent, true),
        eq(stageAttempts.leaseEpoch, attempt.leaseEpoch),
      )).returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

/** The first worker action: reuse a durable compatible success if it exists. */
export async function findCompatibleStageSuccess(
  db: Database,
  input: CompatibleStageIdentity,
): Promise<typeof stageAttempts.$inferSelect | null> {
  assertChecksum(input.inputChecksum, "Stage input checksum");
  const [success] = await db.select().from(stageAttempts).where(and(
    eq(stageAttempts.documentVersionId, input.documentVersionId),
    eq(stageAttempts.stage, input.stage),
    eq(stageAttempts.implementationVersion, input.implementationVersion),
    eq(stageAttempts.inputChecksum, input.inputChecksum),
    eq(stageAttempts.status, "succeeded"),
  )).limit(1);
  return success ?? null;
}

export async function heartbeatStageAttempt(
  db: Database,
  input: AttemptFence & { readonly leaseDurationMs: number; readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const leaseDurationMs = positiveInteger(input.leaseDurationMs, "Lease duration");
  const [updated] = await db.update(stageAttempts).set({
    heartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
    updatedAt: now,
  }).where(and(stageFence(input), gt(stageAttempts.leaseExpiresAt, now))).returning({ id: stageAttempts.id });
  return Boolean(updated);
}

/** Commit output and the next compatible work item in the same transaction. */
export async function completeStageAttempt(
  db: Database,
  input: CompleteStageAttemptInput,
): Promise<CompleteStageAttemptResult> {
  assertNonEmpty(input.outputRef, "Stage output reference");
  assertChecksum(input.outputChecksum, "Stage output checksum");
  if (input.next) assertChecksum(input.next.inputChecksum, "Next-stage input checksum");
  if (input.next && input.next.inputChecksum !== input.outputChecksum) {
    throw new Error("Next-stage input checksum must equal the committed stage output checksum.");
  }
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(stageAttempts)
      .where(eq(stageAttempts.id, input.attemptId)).limit(1).for("update");
    if (!attempt || !fenceMatches(attempt, input)) {
      return { accepted: false, attempt: null, nextAttempt: null };
    }

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${compatibilityLockKey(attempt)}, 0))`);
    const [compatible] = await tx.select().from(stageAttempts).where(and(
      eq(stageAttempts.documentVersionId, attempt.documentVersionId),
      eq(stageAttempts.stage, attempt.stage),
      eq(stageAttempts.implementationVersion, attempt.implementationVersion),
      eq(stageAttempts.inputChecksum, attempt.inputChecksum),
      eq(stageAttempts.status, "succeeded"),
    )).limit(1);
    if (compatible && compatible.id !== attempt.id) {
      if (!compatible.outputRef || !compatible.outputChecksum) {
        throw new Error("Compatible stage success is missing its immutable output contract.");
      }
      const [reused] = await tx.update(stageAttempts).set({
        status: "reused",
        terminalDisposition: "REUSED_SUCCESS",
        reusedAttemptId: compatible.id,
        outputRef: compatible.outputRef,
        outputChecksum: compatible.outputChecksum,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
        completedAt: now,
        updatedAt: now,
      }).where(stageFence(input)).returning();
      if (!reused) return { accepted: false, attempt: null, nextAttempt: null };

      const reusedNext = await commitNextStageOrFinish(
        tx,
        reused,
        input.next,
        compatible.outputChecksum,
        now,
        "Failed to commit next-stage work from concurrent compatible success.",
      );
      return { accepted: true, attempt: reused, nextAttempt: reusedNext };
    }

    const [completed] = await tx.update(stageAttempts).set({
      status: "succeeded",
      terminalDisposition: "SUCCEEDED",
      outputRef: input.outputRef,
      outputChecksum: input.outputChecksum,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      completedAt: now,
      updatedAt: now,
    }).where(stageFence(input)).returning();
    if (!completed) return { accepted: false, attempt: null, nextAttempt: null };

    const nextAttempt = await commitNextStageOrFinish(
      tx,
      completed,
      input.next,
      input.outputChecksum,
      now,
      "Failed to commit next-stage work atomically.",
    );
    return { accepted: true, attempt: completed, nextAttempt };
  });
}

/**
 * Advance a claimed lineage using the one compatible result owned by the
 * document version. The reused row is lineage, not a second durable result.
 */
export async function reuseCompatibleStageSuccess(
  db: Database,
  input: ReuseCompatibleStageSuccessInput,
): Promise<CompleteStageAttemptResult> {
  if (input.next) assertChecksum(input.next.inputChecksum, "Next-stage input checksum");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(stageAttempts)
      .where(eq(stageAttempts.id, input.attemptId)).limit(1).for("update");
    if (!attempt || !fenceMatches(attempt, input)) {
      return { accepted: false, attempt: null, nextAttempt: null };
    }
    const [success] = await tx.select().from(stageAttempts).where(and(
      eq(stageAttempts.id, input.successfulAttemptId),
      eq(stageAttempts.status, "succeeded"),
      eq(stageAttempts.documentVersionId, attempt.documentVersionId),
      eq(stageAttempts.stage, attempt.stage),
      eq(stageAttempts.implementationVersion, attempt.implementationVersion),
      eq(stageAttempts.inputChecksum, attempt.inputChecksum),
    )).limit(1);
    if (!success || !success.outputRef || !success.outputChecksum) {
      throw new Error("Compatible successful stage output is missing or does not match the claimed input.");
    }
    if (input.next && input.next.inputChecksum !== success.outputChecksum) {
      throw new Error("Next-stage input checksum must equal the compatible stage output checksum.");
    }

    const [reused] = await tx.update(stageAttempts).set({
      status: "reused",
      terminalDisposition: "REUSED_SUCCESS",
      reusedAttemptId: success.id,
      outputRef: success.outputRef,
      outputChecksum: success.outputChecksum,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      completedAt: now,
      updatedAt: now,
    }).where(stageFence(input)).returning();
    if (!reused) return { accepted: false, attempt: null, nextAttempt: null };

    const nextAttempt = await commitNextStageOrFinish(
      tx,
      reused,
      input.next,
      success.outputChecksum,
      now,
      "Failed to commit next-stage work from compatible success.",
    );
    return { accepted: true, attempt: reused, nextAttempt };
  });
}

/** Record deterministic termination or append one transient retry history row. */
export async function failStageAttempt(
  db: Database,
  input: FailStageAttemptInput,
): Promise<FailStageAttemptResult> {
  assertNonEmpty(input.errorCode, "Stage error code");
  assertNonEmpty(input.errorMessage, "Stage error message");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(stageAttempts)
      .where(eq(stageAttempts.id, input.attemptId)).limit(1).for("update");
    if (!attempt || !fenceMatches(attempt, input)) {
      return { accepted: false, disposition: null, retryAttempt: null };
    }

    if (input.classification === "deterministic") {
      await terminalFailure(tx, attempt, input, now, "failed", "DETERMINISTIC_FAILURE");
      await tx.update(pipelineRuns).set({ status: "failed", completedAt: now, updatedAt: now })
        .where(and(eq(pipelineRuns.id, attempt.pipelineRunId), eq(pipelineRuns.status, "active")));
      return { accepted: true, disposition: "DETERMINISTIC_FAILURE", retryAttempt: null };
    }

    if (attempt.attemptNumber >= attempt.maxAttempts) {
      await terminalFailure(tx, attempt, input, now, "dead_letter", "DEAD_LETTER");
      await tx.update(pipelineRuns).set({ status: "failed", completedAt: now, updatedAt: now })
        .where(and(eq(pipelineRuns.id, attempt.pipelineRunId), eq(pipelineRuns.status, "active")));
      return { accepted: true, disposition: "DEAD_LETTER", retryAttempt: null };
    }

    const retryDelayMs = positiveInteger(input.retryDelayMs ?? 1_000, "Retry delay");
    const [failed] = await tx.update(stageAttempts).set({
      status: "failed",
      terminalDisposition: "RETRY_SCHEDULED",
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      isCurrent: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    }).where(stageFence(input)).returning();
    if (!failed) return { accepted: false, disposition: null, retryAttempt: null };

    const [retryAttempt] = await tx.insert(stageAttempts).values({
      pipelineRunId: failed.pipelineRunId,
      documentVersionId: failed.documentVersionId,
      accessScopeId: failed.accessScopeId,
      sourceId: failed.sourceId,
      stage: failed.stage,
      implementationVersion: failed.implementationVersion,
      inputChecksum: failed.inputChecksum,
      attemptNumber: failed.attemptNumber + 1,
      maxAttempts: failed.maxAttempts,
      leaseEpoch: failed.leaseEpoch,
      status: "retry_wait",
      nextRunAt: new Date(now.getTime() + retryDelayMs),
    }).returning();
    if (!retryAttempt) throw new Error("Failed to append transient retry history.");
    return { accepted: true, disposition: "RETRY_SCHEDULED", retryAttempt };
  });
}

/** Operator recovery preserves every ownership and compatibility field. */
export async function requeueTerminalAttempt(
  db: Database,
  input: RequeueTerminalAttemptInput,
): Promise<typeof stageAttempts.$inferSelect> {
  assertNonEmpty(input.operator, "Requeue operator");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [dead] = await tx.select().from(stageAttempts)
      .where(eq(stageAttempts.id, input.attemptId)).limit(1).for("update");
    if (!dead || !dead.isCurrent || (dead.status !== "dead_letter" && dead.status !== "failed")) {
      throw new Error("Only a current terminal stage attempt can be requeued.");
    }
    if (dead.inputChecksum !== input.expectedInputChecksum
      || dead.accessScopeId !== input.expectedAccessScopeId
      || dead.sourceId !== input.expectedSourceId
      || dead.documentVersionId !== input.expectedDocumentVersionId) {
      throw new Error("Dead-letter input checksum or immutable ownership changed; requeue rejected.");
    }
    await tx.update(stageAttempts).set({ isCurrent: false, updatedAt: now })
      .where(and(eq(stageAttempts.id, dead.id), eq(stageAttempts.isCurrent, true)));
    const [requeued] = await tx.insert(stageAttempts).values({
      pipelineRunId: dead.pipelineRunId,
      documentVersionId: dead.documentVersionId,
      accessScopeId: dead.accessScopeId,
      sourceId: dead.sourceId,
      stage: dead.stage,
      implementationVersion: dead.implementationVersion,
      inputChecksum: dead.inputChecksum,
      attemptNumber: dead.attemptNumber + 1,
      maxAttempts: dead.maxAttempts + 1,
      leaseEpoch: dead.leaseEpoch + 1,
      nextRunAt: now,
      requeuedBy: input.operator,
      requeuedFromAttemptId: dead.id,
    }).returning();
    if (!requeued) throw new Error("Failed to requeue dead-letter attempt.");
    await tx.update(pipelineRuns).set({ status: "active", completedAt: null, updatedAt: now })
      .where(eq(pipelineRuns.id, dead.pipelineRunId));
    return requeued;
  });
}

/** @deprecated Use requeueTerminalAttempt for operator recovery. */
export const requeueDeadLetterAttempt = requeueTerminalAttempt;

export async function listDeadLetterAttempts(
  db: Database,
  limit = 100,
): Promise<Array<typeof stageAttempts.$inferSelect>> {
  return db.select().from(stageAttempts)
    .where(and(eq(stageAttempts.status, "dead_letter"), eq(stageAttempts.isCurrent, true)))
    .orderBy(asc(stageAttempts.completedAt))
    .limit(boundedPositiveInteger(limit, 1_000, "Dead-letter result limit"));
}

/** Manual runs bypass cadence but retain the same source overlap invariant. */
export async function triggerManualDiscoveryRun(
  db: Database,
  input: TriggerManualDiscoveryRunInput,
): Promise<typeof discoveryRuns.$inferSelect> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(sources)
      .where(eq(sources.id, input.sourceId)).limit(1).for("update");
    if (!source) throw new Error("Source does not exist.");
    if (!source.enabled) throw new Error("Manual discovery cannot run for a disabled source.");
    if (source.emergencyFrozenAt) throw new Error("Manual discovery cannot run for an emergency-frozen source.");
    const [scope] = await tx.select().from(accessScopes)
      .where(eq(accessScopes.id, source.accessScopeId)).limit(1);
    if (!scope?.enabled) throw new Error("Manual discovery cannot run for a disabled access scope.");
    if (scope.emergencyFrozenAt) throw new Error("Manual discovery cannot run for an emergency-frozen access scope.");
    const [schedule] = await tx.select().from(sourceSchedules)
      .where(eq(sourceSchedules.sourceId, source.id)).limit(1);
    if (!schedule || schedule.pausedAt) throw new Error("Manual discovery cannot run for a paused source.");
    const [active] = await tx.select().from(discoveryRuns).where(and(
      eq(discoveryRuns.sourceId, source.id),
      inArray(discoveryRuns.status, ["pending", "running", "retry_wait"]),
    )).limit(1);
    if (active) return active;
    const [run] = await tx.insert(discoveryRuns).values({
      sourceId: source.id,
      configRevisionId: source.configRevisionId,
      scheduledFor: now,
      status: "pending",
    }).returning();
    if (!run) throw new Error("Failed to create manual discovery run.");
    return run;
  });
}

/** Claim source-level work without inventing a document version before fetch. */
export async function claimDiscoveryExecutions(
  db: Database,
  input: ClaimDiscoveryExecutionsInput,
): Promise<Array<typeof discoveryRuns.$inferSelect>> {
  assertNonEmpty(input.owner, "Discovery lease owner");
  const batchSize = boundedPositiveInteger(input.batchSize, 100, "Discovery claim batch size");
  const leaseDurationMs = positiveInteger(input.leaseDurationMs, "Discovery lease duration");
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  return db.transaction(async (tx) => {
    const candidates = await tx.select({ run: discoveryRuns })
      .from(discoveryRuns)
      .innerJoin(sources, eq(sources.id, discoveryRuns.sourceId))
      .innerJoin(accessScopes, eq(accessScopes.id, sources.accessScopeId))
      .innerJoin(sourceSchedules, eq(sourceSchedules.sourceId, sources.id))
      .where(and(
        eq(sources.enabled, true),
        eq(accessScopes.enabled, true),
        isNull(sources.emergencyFrozenAt),
        isNull(accessScopes.emergencyFrozenAt),
        isNull(sourceSchedules.pausedAt),
        or(
          eq(discoveryRuns.status, "pending"),
          and(eq(discoveryRuns.status, "retry_wait"), lte(discoveryRuns.nextRetryAt, now)),
          and(eq(discoveryRuns.status, "running"), lte(discoveryRuns.leaseExpiresAt, now)),
        ),
      ))
      .orderBy(asc(discoveryRuns.createdAt), asc(discoveryRuns.id))
      .limit(batchSize)
      .for("update", { of: discoveryRuns, skipLocked: true });

    const claimed: Array<typeof discoveryRuns.$inferSelect> = [];
    for (const { run } of candidates) {
      const [updated] = await tx.update(discoveryRuns).set({
        status: "running",
        attemptCount: run.status === "running" ? run.attemptCount : sql`${discoveryRuns.attemptCount} + 1`,
        leaseOwner: input.owner,
        leaseEpoch: sql`${discoveryRuns.leaseEpoch} + 1`,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: run.startedAt ?? now,
        nextRetryAt: null,
      }).where(and(
        eq(discoveryRuns.id, run.id),
        eq(discoveryRuns.leaseEpoch, run.leaseEpoch),
      )).returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function heartbeatDiscoveryExecution(
  db: Database,
  input: DiscoveryExecutionFence & { readonly leaseDurationMs: number; readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [updated] = await db.update(discoveryRuns).set({
    heartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + positiveInteger(input.leaseDurationMs, "Discovery lease duration")),
  }).where(and(discoveryFence(input), gt(discoveryRuns.leaseExpiresAt, now)))
    .returning({ id: discoveryRuns.id });
  return Boolean(updated);
}

export async function completeDiscoveryExecution(
  db: Database,
  input: DiscoveryExecutionFence & { readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [completed] = await db.update(discoveryRuns).set({
    status: "succeeded",
    terminalDisposition: "SUCCEEDED",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    completedAt: now,
    errorCode: null,
    errorMessage: null,
  }).where(discoveryFence(input)).returning({ id: discoveryRuns.id });
  return Boolean(completed);
}

export async function failDiscoveryExecution(
  db: Database,
  input: FailDiscoveryExecutionInput,
): Promise<{ readonly accepted: boolean; readonly disposition: StageTerminalDisposition | null }> {
  assertNonEmpty(input.errorCode, "Discovery error code");
  assertNonEmpty(input.errorMessage, "Discovery error message");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns)
      .where(eq(discoveryRuns.id, input.discoveryRunId)).limit(1).for("update");
    if (!run || !discoveryFenceMatches(run, input)) return { accepted: false, disposition: null };
    const exhausted = input.classification === "transient" && run.attemptCount >= run.maxAttempts;
    const retryAt = input.classification === "transient" && !exhausted
      ? new Date(now.getTime() + positiveInteger(input.retryDelayMs ?? 1_000, "Discovery retry delay"))
      : null;
    const disposition: StageTerminalDisposition = input.classification === "deterministic"
      ? "DETERMINISTIC_FAILURE"
      : exhausted ? "DEAD_LETTER" : "RETRY_SCHEDULED";
    const status = input.classification === "deterministic"
      ? "failed" as const
      : exhausted ? "dead_letter" as const : "retry_wait" as const;
    const history = [...run.retryHistory, {
      attempt: run.attemptCount,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      failedAt: now.toISOString(),
      retryAt: retryAt?.toISOString() ?? null,
    }];
    const [failed] = await tx.update(discoveryRuns).set({
      status,
      terminalDisposition: disposition,
      nextRetryAt: retryAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: retryAt ? null : now,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryHistory: history,
    }).where(discoveryFence(input)).returning({ id: discoveryRuns.id });
    return { accepted: Boolean(failed), disposition: failed ? disposition : null };
  });
}

export async function releaseDiscoveryExecutionLease(
  db: Database,
  input: DiscoveryExecutionFence & { readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [released] = await db.update(discoveryRuns).set({
    status: "retry_wait",
    nextRetryAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
  }).where(discoveryFence(input)).returning({ id: discoveryRuns.id });
  return Boolean(released);
}

export async function requeueDeadLetterDiscoveryRun(
  db: Database,
  input: {
    readonly discoveryRunId: string;
    readonly operator: string;
    readonly expectedSourceId: string;
    readonly expectedConfigRevisionId: string;
    readonly now?: Date;
  },
): Promise<typeof discoveryRuns.$inferSelect> {
  assertNonEmpty(input.operator, "Discovery requeue operator");
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(discoveryRuns)
      .where(eq(discoveryRuns.id, input.discoveryRunId)).limit(1).for("update");
    if (!run || run.status !== "dead_letter") throw new Error("Only a dead-letter discovery run can be requeued.");
    if (run.sourceId !== input.expectedSourceId
      || run.configRevisionId !== input.expectedConfigRevisionId) {
      throw new Error("Dead-letter discovery ownership or configuration changed; requeue rejected.");
    }
    const [requeued] = await tx.update(discoveryRuns).set({
      status: "pending",
      maxAttempts: run.attemptCount + 1,
      nextRetryAt: null,
      leaseEpoch: run.leaseEpoch + 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: null,
      terminalDisposition: null,
      errorCode: null,
      errorMessage: null,
    }).where(and(eq(discoveryRuns.id, run.id), eq(discoveryRuns.status, "dead_letter"))).returning();
    if (!requeued) throw new Error("Failed to requeue discovery run.");
    return requeued;
  });
}

export async function pauseSourceSchedule(db: Database, sourceId: string, now = new Date()): Promise<boolean> {
  const [paused] = await db.update(sourceSchedules).set({ pausedAt: now, updatedAt: now })
    .where(and(eq(sourceSchedules.sourceId, sourceId), isNull(sourceSchedules.pausedAt)))
    .returning({ sourceId: sourceSchedules.sourceId });
  return Boolean(paused);
}

export async function resumeSourceSchedule(db: Database, sourceId: string, now = new Date()): Promise<boolean> {
  const [resumed] = await db.update(sourceSchedules).set({ pausedAt: null, updatedAt: now })
    .where(and(eq(sourceSchedules.sourceId, sourceId), isNotNull(sourceSchedules.pausedAt)))
    .returning({ sourceId: sourceSchedules.sourceId });
  return Boolean(resumed);
}

export async function setSourceEmergencyFreeze(
  db: Database,
  input: { readonly sourceId: string; readonly reason: string | null; readonly now?: Date },
): Promise<boolean> {
  if (input.reason !== null) assertNonEmpty(input.reason, "Emergency freeze reason");
  const now = input.now ?? new Date();
  const [updated] = await db.update(sources).set({
    emergencyFrozenAt: input.reason === null ? null : now,
    emergencyFreezeReason: input.reason,
    updatedAt: now,
  }).where(eq(sources.id, input.sourceId)).returning({ id: sources.id });
  return Boolean(updated);
}

export async function setAccessScopeEmergencyFreeze(
  db: Database,
  input: { readonly accessScopeId: string; readonly reason: string | null; readonly now?: Date },
): Promise<boolean> {
  if (input.reason !== null) assertNonEmpty(input.reason, "Emergency freeze reason");
  const now = input.now ?? new Date();
  const [updated] = await db.update(accessScopes).set({
    emergencyFrozenAt: input.reason === null ? null : now,
    emergencyFreezeReason: input.reason,
    updatedAt: now,
  }).where(eq(accessScopes.id, input.accessScopeId)).returning({ id: accessScopes.id });
  return Boolean(updated);
}

export async function pausePipelineRun(db: Database, pipelineRunId: string, now = new Date()): Promise<boolean> {
  const [updated] = await db.update(pipelineRuns).set({ pausedAt: now, updatedAt: now })
    .where(and(eq(pipelineRuns.id, pipelineRunId), eq(pipelineRuns.status, "active")))
    .returning({ id: pipelineRuns.id });
  return Boolean(updated);
}

export async function resumePipelineRun(db: Database, pipelineRunId: string, now = new Date()): Promise<boolean> {
  const [updated] = await db.update(pipelineRuns).set({ pausedAt: null, updatedAt: now })
    .where(and(
      eq(pipelineRuns.id, pipelineRunId),
      eq(pipelineRuns.status, "active"),
      isNotNull(pipelineRuns.pausedAt),
    ))
    .returning({ id: pipelineRuns.id });
  return Boolean(updated);
}

export async function cancelStageAttemptBeforeStart(
  db: Database,
  attemptId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  assertNonEmpty(reason, "Cancellation reason");
  return db.transaction(async (tx) => {
    const [cancelled] = await tx.update(stageAttempts).set({
      status: "cancelled",
      terminalDisposition: "CANCELLED",
      errorCode: "OPERATOR_CANCELLED",
      errorMessage: reason,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(stageAttempts.id, attemptId),
      inArray(stageAttempts.status, ["pending", "retry_wait"]),
      eq(stageAttempts.isCurrent, true),
    )).returning({ id: stageAttempts.id, pipelineRunId: stageAttempts.pipelineRunId });
    if (!cancelled) return false;
    await tx.update(pipelineRuns).set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(and(eq(pipelineRuns.id, cancelled.pipelineRunId), eq(pipelineRuns.status, "active")));
    return true;
  });
}

/** Graceful shutdown makes a claimed row immediately recoverable without consuming retry budget. */
export async function releaseStageAttemptLease(
  db: Database,
  input: AttemptFence & { readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [released] = await db.update(stageAttempts).set({
    status: "retry_wait",
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    nextRunAt: now,
    updatedAt: now,
  }).where(stageFence(input)).returning({ id: stageAttempts.id });
  return Boolean(released);
}

function stageFence(input: AttemptFence) {
  return and(
    eq(stageAttempts.id, input.attemptId),
    eq(stageAttempts.status, "running"),
    eq(stageAttempts.isCurrent, true),
    eq(stageAttempts.leaseOwner, input.owner),
    eq(stageAttempts.leaseEpoch, input.leaseEpoch),
  );
}

function discoveryFence(input: DiscoveryExecutionFence) {
  return and(
    eq(discoveryRuns.id, input.discoveryRunId),
    eq(discoveryRuns.status, "running"),
    eq(discoveryRuns.leaseOwner, input.owner),
    eq(discoveryRuns.leaseEpoch, input.leaseEpoch),
  );
}

function discoveryFenceMatches(
  run: typeof discoveryRuns.$inferSelect,
  input: DiscoveryExecutionFence,
): boolean {
  return run.status === "running"
    && run.leaseOwner === input.owner
    && run.leaseEpoch === input.leaseEpoch;
}

function fenceMatches(
  attempt: typeof stageAttempts.$inferSelect,
  input: AttemptFence,
): boolean {
  return attempt.status === "running"
    && attempt.isCurrent
    && attempt.leaseOwner === input.owner
    && attempt.leaseEpoch === input.leaseEpoch;
}

type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function commitNextStageOrFinish(
  tx: DatabaseTransaction,
  attempt: typeof stageAttempts.$inferSelect,
  next: NextStageInput | undefined,
  inputChecksum: string,
  now: Date,
  insertionError: string,
): Promise<typeof stageAttempts.$inferSelect | null> {
  if (!next) {
    await tx.update(pipelineRuns).set({ status: "succeeded", completedAt: now, updatedAt: now })
      .where(and(eq(pipelineRuns.id, attempt.pipelineRunId), eq(pipelineRuns.status, "active")));
    return null;
  }

  const [inserted] = await tx.insert(stageAttempts).values({
    pipelineRunId: attempt.pipelineRunId,
    documentVersionId: attempt.documentVersionId,
    accessScopeId: attempt.accessScopeId,
    sourceId: attempt.sourceId,
    stage: next.stage,
    implementationVersion: next.implementationVersion,
    inputChecksum,
    maxAttempts: positiveInteger(next.maxAttempts ?? attempt.maxAttempts, "Maximum attempts"),
    nextRunAt: now,
  }).onConflictDoNothing().returning();
  const existing = inserted ?? (await tx.select().from(stageAttempts).where(and(
    eq(stageAttempts.pipelineRunId, attempt.pipelineRunId),
    eq(stageAttempts.stage, next.stage),
    eq(stageAttempts.implementationVersion, next.implementationVersion),
    eq(stageAttempts.inputChecksum, inputChecksum),
    eq(stageAttempts.isCurrent, true),
  )).limit(1))[0] ?? null;
  if (!existing) throw new Error(insertionError);
  return existing;
}

async function terminalFailure(
  tx: DatabaseTransaction,
  attempt: typeof stageAttempts.$inferSelect,
  input: FailStageAttemptInput,
  now: Date,
  status: "failed" | "dead_letter",
  disposition: "DETERMINISTIC_FAILURE" | "DEAD_LETTER",
): Promise<void> {
  const [failed] = await tx.update(stageAttempts).set({
    status,
    terminalDisposition: disposition,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: now,
    updatedAt: now,
  }).where(stageFence(input)).returning({ id: stageAttempts.id });
  if (!failed || failed.id !== attempt.id) throw new Error("Stage failure fence changed during commit.");
}

function assertRunOwnership(
  run: typeof pipelineRuns.$inferSelect,
  version: typeof documentVersions.$inferSelect,
): void {
  if (run.documentVersionId !== version.id
    || run.accessScopeId !== version.accessScopeId
    || run.sourceId !== version.sourceId) {
    throw new Error("Pipeline run ownership does not match its immutable document version.");
  }
}

function compatibilityLockKey(attempt: typeof stageAttempts.$inferSelect): string {
  return [
    "mf-rag-stage-result-v1",
    attempt.documentVersionId,
    attempt.stage,
    attempt.implementationVersion,
    attempt.inputChecksum,
  ].join(":");
}

function assertChecksum(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256 value.`);
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  const integer = positiveInteger(value, label);
  if (integer > maximum) throw new Error(`${label} cannot exceed ${maximum}.`);
  return integer;
}
