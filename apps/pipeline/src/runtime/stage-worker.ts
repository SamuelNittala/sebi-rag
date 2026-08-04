import type { DocumentPipelineStage } from "@mf-rag/types";

import type { RetryPolicy, StageFailureClassification } from "./retry-policy.ts";
import { DeterministicStageError } from "./retry-policy.ts";
import type { StageRegistry } from "./stage-registry.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ClaimedStageWork {
  readonly id: string;
  readonly pipelineRunId: string;
  readonly documentVersionId: string;
  readonly accessScopeId: string;
  readonly sourceId: string;
  readonly stage: DocumentPipelineStage;
  readonly implementationVersion: string;
  readonly inputChecksum: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
}

export interface CompatibleStageSuccess {
  readonly id: string;
  readonly outputRef: string;
  readonly outputChecksum: string;
}

export interface StageFenceInput {
  readonly attemptId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface NextStageInput {
  readonly stage: DocumentPipelineStage;
  readonly implementationVersion: string;
  readonly inputChecksum: string;
}

export interface StageRuntimeRepository {
  claim(input: {
    readonly owner: string;
    readonly batchSize: number;
    readonly leaseDurationMs: number;
  }): Promise<ClaimedStageWork[]>;
  findCompatibleSuccess(input: {
    readonly documentVersionId: string;
    readonly stage: DocumentPipelineStage;
    readonly implementationVersion: string;
    readonly inputChecksum: string;
  }): Promise<CompatibleStageSuccess | null>;
  heartbeat(input: StageFenceInput & { readonly leaseDurationMs: number }): Promise<boolean>;
  complete(input: StageFenceInput & {
    readonly outputRef: string;
    readonly outputChecksum: string;
    readonly next?: NextStageInput;
  }): Promise<boolean>;
  reuse(input: StageFenceInput & {
    readonly successfulAttemptId: string;
    readonly next?: NextStageInput;
  }): Promise<boolean>;
  fail(input: StageFenceInput & {
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly classification: StageFailureClassification;
    readonly retryDelayMs: number;
  }): Promise<boolean>;
  release(input: StageFenceInput): Promise<boolean>;
}

export interface StageWorkerOptions {
  readonly owner: string;
  readonly repository: StageRuntimeRepository;
  readonly registry: StageRegistry;
  readonly retryPolicy: RetryPolicy;
  readonly claimBatchSize: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
}

export interface StopStageWorkerOptions {
  readonly gracePeriodMs: number;
}

interface ActiveExecution {
  readonly work: ClaimedStageWork;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

class StaleLeaseError extends Error {
  constructor() {
    super("Stage lease fence is no longer owned by this worker.");
    this.name = "StaleLeaseError";
  }
}

/** Generic fenced worker; no connector, parser, or publication business logic lives here. */
export class StageWorker {
  private readonly active = new Map<string, ActiveExecution>();
  private stopping = false;

  constructor(private readonly options: StageWorkerOptions) {
    assertNonEmpty(options.owner, "Worker owner");
    positiveInteger(options.claimBatchSize, "Claim batch size");
    positiveInteger(options.leaseDurationMs, "Lease duration");
    positiveInteger(options.heartbeatIntervalMs, "Heartbeat interval");
    if (options.heartbeatIntervalMs >= options.leaseDurationMs) {
      throw new Error("Heartbeat interval must be shorter than the lease duration.");
    }
  }

  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    const claimed = await this.options.repository.claim({
      owner: this.options.owner,
      batchSize: this.options.claimBatchSize,
      leaseDurationMs: this.options.leaseDurationMs,
    });
    if (this.stopping) {
      await Promise.all(claimed.map((work) => this.options.repository.release(fence(work))));
      return 0;
    }

    const executions = claimed.map((work) => {
      const controller = new AbortController();
      const promise = this.execute(work, controller).finally(() => this.active.delete(work.id));
      this.active.set(work.id, { work, controller, promise });
      return promise;
    });
    await Promise.all(executions);
    return claimed.length;
  }

  async runUntilStopped(pollIntervalMs: number): Promise<void> {
    positiveInteger(pollIntervalMs, "Worker poll interval");
    while (!this.stopping) {
      const claimed = await this.runOnce();
      if (claimed === 0 && !this.stopping) await Bun.sleep(pollIntervalMs);
    }
  }

  async stop(input: StopStageWorkerOptions): Promise<void> {
    if (!Number.isSafeInteger(input.gracePeriodMs) || input.gracePeriodMs < 0) {
      throw new Error("Shutdown grace period must be a non-negative integer.");
    }
    this.stopping = true;
    const initial = [...this.active.values()];
    if (initial.length === 0) return;

    if (input.gracePeriodMs > 0) {
      await Promise.race([
        Promise.allSettled(initial.map(({ promise }) => promise)),
        Bun.sleep(input.gracePeriodMs),
      ]);
    }
    const unfinished = [...this.active.values()];
    for (const execution of unfinished) execution.controller.abort(new Error("Worker is shutting down."));
    await Promise.all(unfinished.map(({ work }) => this.options.repository.release(fence(work))));
    await Promise.allSettled(unfinished.map(({ promise }) => promise));
  }

  private async execute(work: ClaimedStageWork, controller: AbortController): Promise<void> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      validateClaimedWork(work, this.options.owner);
      const registration = this.options.registry.get(work.stage);
      if (registration.implementationVersion !== work.implementationVersion) {
        throw new DeterministicStageError(
          "IMPLEMENTATION_VERSION_MISMATCH",
          `Claimed ${work.stage} version does not match the enabled handler.`,
        );
      }

      const compatible = await this.options.repository.findCompatibleSuccess({
        documentVersionId: work.documentVersionId,
        stage: work.stage,
        implementationVersion: work.implementationVersion,
        inputChecksum: work.inputChecksum,
      });
      if (compatible && compatible.id !== work.id) {
        validateOutput(compatible.outputRef, compatible.outputChecksum);
        await this.options.repository.reuse({
          ...fence(work),
          successfulAttemptId: compatible.id,
          ...withNext(this.options.registry, work.stage, compatible.outputChecksum),
        });
        return;
      }

      heartbeat = setInterval(() => {
        void this.options.repository.heartbeat({
          ...fence(work),
          leaseDurationMs: this.options.leaseDurationMs,
        }).then((accepted) => {
          if (!accepted) controller.abort(new StaleLeaseError());
        }).catch(() => controller.abort(new StaleLeaseError()));
      }, this.options.heartbeatIntervalMs);

      const output = await registration.handler({
        pipelineRunId: work.pipelineRunId,
        documentVersionId: work.documentVersionId,
        accessScopeId: work.accessScopeId,
        sourceId: work.sourceId,
        inputChecksum: work.inputChecksum,
        signal: controller.signal,
      });
      validateOutput(output.outputRef, output.outputChecksum);
      await this.options.repository.complete({
        ...fence(work),
        outputRef: output.outputRef,
        outputChecksum: output.outputChecksum,
        ...withNext(this.options.registry, work.stage, output.outputChecksum),
      });
    } catch (error) {
      if (error instanceof StaleLeaseError || controller.signal.reason instanceof StaleLeaseError) return;
      if (this.stopping) return;
      const failure = error instanceof Error && error.message.startsWith("Invalid claimed stage envelope:")
        ? { classification: "deterministic" as const, errorCode: "INVALID_STAGE_ENVELOPE", errorMessage: error.message }
        : this.options.retryPolicy.classify(error);
      await this.options.repository.fail({
        ...fence(work),
        ...failure,
        retryDelayMs: this.options.retryPolicy.delayMs(work.attemptNumber),
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

function withNext(registry: StageRegistry, stage: DocumentPipelineStage, inputChecksum: string): { next?: NextStageInput } {
  const next = registry.next(stage);
  return next
    ? { next: { stage: next.stage, implementationVersion: next.implementationVersion, inputChecksum } }
    : {};
}

function fence(work: ClaimedStageWork): StageFenceInput {
  return { attemptId: work.id, owner: work.leaseOwner, leaseEpoch: work.leaseEpoch };
}

function validateClaimedWork(work: ClaimedStageWork, expectedOwner: string): void {
  const identifiers = [
    work.id,
    work.pipelineRunId,
    work.documentVersionId,
    work.accessScopeId,
    work.sourceId,
    work.implementationVersion,
  ];
  if (identifiers.some((value) => !value.trim())
    || work.leaseOwner !== expectedOwner
    || !Number.isSafeInteger(work.leaseEpoch)
    || work.leaseEpoch <= 0
    || !SHA256_PATTERN.test(work.inputChecksum)) {
    throw new Error("Invalid claimed stage envelope: ownership, lease, and checksum are required and immutable.");
  }
}

function validateOutput(outputRef: string, outputChecksum: string): void {
  if (!outputRef.trim() || !SHA256_PATTERN.test(outputChecksum)) {
    throw new DeterministicStageError("INVALID_STAGE_OUTPUT", "Stage output requires a reference and lowercase SHA-256 checksum.");
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
