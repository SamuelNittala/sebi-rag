import {
  claimDueDiscoveryRun,
  claimDiscoveryExecutions,
  claimStageAttempts,
  completeStageAttempt,
  completeDiscoveryExecution,
  failStageAttempt,
  failDiscoveryExecution,
  findCompatibleStageSuccess,
  heartbeatStageAttempt,
  heartbeatDiscoveryExecution,
  pauseSourceSchedule,
  releaseStageAttemptLease,
  releaseDiscoveryExecutionLease,
  resumeSourceSchedule,
  reuseCompatibleStageSuccess,
  triggerManualDiscoveryRun,
  type Database,
} from "@mf-rag/db";

import type { DiscoveryExecutionRepository, DiscoverySchedulerStore } from "./scheduler.ts";
import type { ClaimedStageWork, StageRuntimeRepository } from "./stage-worker.ts";

/** Production PostgreSQL adapter; handlers still execute outside query transactions. */
export function createDatabaseStageRuntimeRepository(db: Database): StageRuntimeRepository {
  return {
    async claim(input) {
      const attempts = await claimStageAttempts(db, input);
      return attempts.map(toClaimedStageWork);
    },
    async findCompatibleSuccess(input) {
      const success = await findCompatibleStageSuccess(db, input);
      if (!success) return null;
      if (!success.outputRef || !success.outputChecksum) {
        throw new Error("Compatible stage success is missing its immutable output contract.");
      }
      return { id: success.id, outputRef: success.outputRef, outputChecksum: success.outputChecksum };
    },
    heartbeat: (input) => heartbeatStageAttempt(db, input),
    async complete(input) {
      return (await completeStageAttempt(db, input)).accepted;
    },
    async reuse(input) {
      return (await reuseCompatibleStageSuccess(db, input)).accepted;
    },
    async fail(input) {
      return (await failStageAttempt(db, input)).accepted;
    },
    release: (input) => releaseStageAttemptLease(db, input),
  };
}

type ManualDiscoveryRun = Awaited<ReturnType<typeof triggerManualDiscoveryRun>>;

/** Durable scheduler/operator adapter. Manual runs do not enable source cadence. */
export function createDatabaseDiscoverySchedulerStore(
  db: Database,
): DiscoverySchedulerStore<ManualDiscoveryRun> {
  return {
    async claimDue() {
      return (await claimDueDiscoveryRun(db))?.run ?? null;
    },
    trigger: (sourceId) => triggerManualDiscoveryRun(db, { sourceId }),
    pause: (sourceId) => pauseSourceSchedule(db, sourceId),
    resume: (sourceId) => resumeSourceSchedule(db, sourceId),
  };
}

export function createDatabaseDiscoveryExecutionRepository(db: Database): DiscoveryExecutionRepository {
  return {
    async claim(input) {
      const runs = await claimDiscoveryExecutions(db, input);
      return runs.map((run) => {
        if (!run.leaseOwner) throw new Error("Claimed discovery run is missing its lease owner.");
        return {
          id: run.id,
          sourceId: run.sourceId,
          configRevisionId: run.configRevisionId,
          scheduledFor: run.scheduledFor,
          attemptCount: run.attemptCount,
          leaseOwner: run.leaseOwner,
          leaseEpoch: run.leaseEpoch,
        };
      });
    },
    heartbeat: (input) => heartbeatDiscoveryExecution(db, input),
    complete: (input) => completeDiscoveryExecution(db, input),
    async fail(input) {
      return (await failDiscoveryExecution(db, input)).accepted;
    },
    release: (input) => releaseDiscoveryExecutionLease(db, input),
  };
}

function toClaimedStageWork(
  attempt: Awaited<ReturnType<typeof claimStageAttempts>>[number],
): ClaimedStageWork {
  if (!attempt.leaseOwner) throw new Error("Claimed stage attempt is missing its lease owner.");
  return {
    id: attempt.id,
    pipelineRunId: attempt.pipelineRunId,
    documentVersionId: attempt.documentVersionId,
    accessScopeId: attempt.accessScopeId,
    sourceId: attempt.sourceId,
    stage: attempt.stage,
    implementationVersion: attempt.implementationVersion,
    inputChecksum: attempt.inputChecksum,
    attemptNumber: attempt.attemptNumber,
    maxAttempts: attempt.maxAttempts,
    leaseOwner: attempt.leaseOwner,
    leaseEpoch: attempt.leaseEpoch,
  };
}
