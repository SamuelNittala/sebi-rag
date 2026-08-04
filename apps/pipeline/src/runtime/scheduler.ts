import type { RetryPolicy, StageFailureClassification } from "./retry-policy.ts";

export interface DiscoveryRunClaim {
  readonly id: string;
}

export interface DiscoverySchedulerStore<TClaim extends DiscoveryRunClaim = DiscoveryRunClaim> {
  claimDue(): Promise<TClaim | null>;
  trigger(sourceId: string): Promise<TClaim>;
  pause(sourceId: string): Promise<boolean>;
  resume(sourceId: string): Promise<boolean>;
}

export interface DiscoverySchedulerOptions<TClaim extends DiscoveryRunClaim> {
  readonly store: DiscoverySchedulerStore<TClaim>;
  readonly maxClaimsPerTick: number;
}

/** Claims durable discovery records only. Fetching is performed by later stage adapters. */
export class DiscoveryScheduler<TClaim extends DiscoveryRunClaim = DiscoveryRunClaim> {
  private readonly maxClaimsPerTick: number;

  constructor(private readonly options: DiscoverySchedulerOptions<TClaim>) {
    this.maxClaimsPerTick = boundedPositiveInteger(options.maxClaimsPerTick, 100, "Claims per scheduler tick");
  }

  async tick(): Promise<TClaim[]> {
    const claimed: TClaim[] = [];
    while (claimed.length < this.maxClaimsPerTick) {
      const run = await this.options.store.claimDue();
      if (!run) break;
      claimed.push(run);
    }
    return claimed;
  }

  manualTrigger(sourceId: string): Promise<TClaim> {
    assertIdentifier(sourceId, "Source ID");
    return this.options.store.trigger(sourceId);
  }

  pause(sourceId: string): Promise<boolean> {
    assertIdentifier(sourceId, "Source ID");
    return this.options.store.pause(sourceId);
  }

  resume(sourceId: string): Promise<boolean> {
    assertIdentifier(sourceId, "Source ID");
    return this.options.store.resume(sourceId);
  }
}

export interface ClaimedDiscoveryExecution {
  readonly id: string;
  readonly sourceId: string;
  readonly configRevisionId: string;
  readonly scheduledFor: Date;
  readonly attemptCount: number;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
}

export interface DiscoveryExecutionFence {
  readonly discoveryRunId: string;
  readonly owner: string;
  readonly leaseEpoch: number;
}

export interface DiscoveryExecutionRepository {
  claim(input: { readonly owner: string; readonly batchSize: number; readonly leaseDurationMs: number }): Promise<ClaimedDiscoveryExecution[]>;
  heartbeat(input: DiscoveryExecutionFence & { readonly leaseDurationMs: number }): Promise<boolean>;
  complete(input: DiscoveryExecutionFence): Promise<boolean>;
  fail(input: DiscoveryExecutionFence & {
    readonly classification: StageFailureClassification;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly retryDelayMs: number;
  }): Promise<boolean>;
  release(input: DiscoveryExecutionFence): Promise<boolean>;
}

export interface DiscoveryWorkerOptions {
  readonly owner: string;
  readonly repository: DiscoveryExecutionRepository;
  readonly handler: (input: {
    readonly discoveryRunId: string;
    readonly sourceId: string;
    readonly configRevisionId: string;
    readonly scheduledFor: Date;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly retryPolicy: RetryPolicy;
  readonly claimBatchSize: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
}

/** Source-level DISCOVER/FETCH execution; document stages start only after version readiness. */
export class DiscoveryWorker {
  private stopping = false;
  private readonly active = new Map<string, {
    readonly work: ClaimedDiscoveryExecution;
    readonly controller: AbortController;
    readonly promise: Promise<void>;
  }>();

  constructor(private readonly options: DiscoveryWorkerOptions) {
    assertIdentifier(options.owner, "Discovery worker owner");
    boundedPositiveInteger(options.claimBatchSize, 100, "Discovery claim batch size");
    boundedPositiveInteger(options.leaseDurationMs, Number.MAX_SAFE_INTEGER, "Discovery lease duration");
    boundedPositiveInteger(options.heartbeatIntervalMs, Number.MAX_SAFE_INTEGER, "Discovery heartbeat interval");
    if (options.heartbeatIntervalMs >= options.leaseDurationMs) {
      throw new Error("Discovery heartbeat interval must be shorter than its lease duration.");
    }
  }

  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    const work = await this.options.repository.claim({
      owner: this.options.owner,
      batchSize: this.options.claimBatchSize,
      leaseDurationMs: this.options.leaseDurationMs,
    });
    if (this.stopping) {
      await Promise.all(work.map((item) => this.options.repository.release(discoveryFence(item))));
      return 0;
    }
    const promises = work.map((item) => {
      const controller = new AbortController();
      const promise = this.execute(item, controller).finally(() => this.active.delete(item.id));
      this.active.set(item.id, { work: item, controller, promise });
      return promise;
    });
    await Promise.all(promises);
    return work.length;
  }

  async stop(gracePeriodMs = 30_000): Promise<void> {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) throw new Error("Discovery shutdown grace must be non-negative.");
    this.stopping = true;
    const initial = [...this.active.values()];
    if (initial.length === 0) return;
    if (gracePeriodMs > 0) {
      await Promise.race([Promise.allSettled(initial.map((entry) => entry.promise)), Bun.sleep(gracePeriodMs)]);
    }
    const unfinished = [...this.active.values()];
    unfinished.forEach((entry) => entry.controller.abort(new Error("Discovery worker is shutting down.")));
    await Promise.all(unfinished.map((entry) => this.options.repository.release(discoveryFence(entry.work))));
    await Promise.allSettled(unfinished.map((entry) => entry.promise));
  }

  private async execute(work: ClaimedDiscoveryExecution, controller: AbortController): Promise<void> {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    try {
      validateDiscoveryClaim(work, this.options.owner);
      heartbeat = setInterval(() => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        void this.options.repository.heartbeat({
          ...discoveryFence(work),
          leaseDurationMs: this.options.leaseDurationMs,
        }).then((accepted) => {
          if (!accepted) controller.abort(new Error("Discovery lease is stale."));
        }).catch(() => controller.abort(new Error("Discovery heartbeat failed.")))
          .finally(() => { heartbeatInFlight = false; });
      }, this.options.heartbeatIntervalMs);
      await this.options.handler({
        discoveryRunId: work.id,
        sourceId: work.sourceId,
        configRevisionId: work.configRevisionId,
        scheduledFor: work.scheduledFor,
        signal: controller.signal,
      });
      await this.options.repository.complete(discoveryFence(work));
    } catch (error) {
      if (this.stopping || controller.signal.aborted) return;
      const failure = this.options.retryPolicy.classify(error);
      await this.options.repository.fail({
        ...discoveryFence(work),
        ...failure,
        retryDelayMs: this.options.retryPolicy.delayMs(work.attemptCount),
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}

function discoveryFence(work: ClaimedDiscoveryExecution): DiscoveryExecutionFence {
  return { discoveryRunId: work.id, owner: work.leaseOwner, leaseEpoch: work.leaseEpoch };
}

function validateDiscoveryClaim(work: ClaimedDiscoveryExecution, owner: string): void {
  if (!work.id.trim() || !work.sourceId.trim() || !work.configRevisionId.trim()
    || work.leaseOwner !== owner || work.leaseEpoch <= 0 || work.attemptCount <= 0) {
    throw new Error("Invalid claimed discovery execution envelope.");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}.`);
  }
  return value;
}
