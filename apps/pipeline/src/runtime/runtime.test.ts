import { describe, expect, test } from "bun:test";

import { DiscoveryScheduler, DiscoveryWorker, type DiscoveryExecutionRepository } from "./scheduler.ts";
import { StageRegistry, deriveStageImplementationVersion } from "./stage-registry.ts";
import {
  StageWorker,
  type ClaimedStageWork,
  type StageRuntimeRepository,
} from "./stage-worker.ts";
import {
  DeterministicStageError,
  TransientStageError,
  createRetryPolicy,
} from "./retry-policy.ts";

const checksum = (character: string) => character.repeat(64);
const parseIdentity = {
  configChecksum: checksum("b"),
};
const chunkIdentity = {
  configChecksum: checksum("c"),
};
const PARSE_IMPLEMENTATION = deriveStageImplementationVersion(parseIdentity);
const CHUNK_IMPLEMENTATION = deriveStageImplementationVersion(chunkIdentity);

function claimed(overrides: Partial<ClaimedStageWork> = {}): ClaimedStageWork {
  return {
    id: "attempt-1",
    pipelineRunId: "run-1",
    documentVersionId: "version-1",
    accessScopeId: "scope-910",
    sourceId: "source-1",
    stage: "PARSE",
    implementationVersion: PARSE_IMPLEMENTATION,
    inputChecksum: checksum("1"),
    attemptNumber: 1,
    maxAttempts: 3,
    leaseOwner: "worker-a",
    leaseEpoch: 1,
    ...overrides,
  };
}

function fakeRepository(work: ClaimedStageWork[] = [claimed()]) {
  const completed: unknown[] = [];
  const reused: unknown[] = [];
  const failed: unknown[] = [];
  const released: unknown[] = [];
  let compatible: Awaited<ReturnType<StageRuntimeRepository["findCompatibleSuccess"]>> = null;
  const repository: StageRuntimeRepository = {
    claim: async () => work.splice(0),
    findCompatibleSuccess: async () => compatible,
    heartbeat: async () => true,
    complete: async (input) => { completed.push(input); return true; },
    reuse: async (input) => { reused.push(input); return true; },
    fail: async (input) => { failed.push(input); return true; },
    release: async (input) => { released.push(input); return true; },
  };
  return {
    repository,
    completed,
    reused,
    failed,
    released,
    setCompatible(value: typeof compatible) { compatible = value; },
  };
}

describe("generic stage worker", () => {
  test("compatible success is looked up before handler execution and advances exactly once", async () => {
    const fake = fakeRepository();
    fake.setCompatible({ id: "success-1", outputRef: "artifact://parsed", outputChecksum: checksum("2") });
    let handlerCalls = 0;
    const registry = new StageRegistry([
      {
        stage: "PARSE",
        implementationIdentity: parseIdentity,
        handler: async () => {
          handlerCalls += 1;
          return { outputRef: "artifact://unexpected", outputChecksum: checksum("9") };
        },
      },
      {
        stage: "CHUNK_AND_INSPECT",
        implementationIdentity: chunkIdentity,
        handler: async () => ({ outputRef: "artifact://chunks", outputChecksum: checksum("3") }),
      },
    ]);
    const worker = new StageWorker({
      owner: "worker-a",
      repository: fake.repository,
      registry,
      retryPolicy: createRetryPolicy(),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      claimBatchSize: 5,
    });

    expect(await worker.runOnce()).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(fake.reused).toHaveLength(1);
    expect(fake.reused[0]).toMatchObject({
      successfulAttemptId: "success-1",
      next: { stage: "CHUNK_AND_INSPECT", implementationVersion: CHUNK_IMPLEMENTATION, inputChecksum: checksum("2") },
    });
  });

  test("transient and deterministic errors use bounded retry classification", async () => {
    const transientFake = fakeRepository();
    const transientWorker = new StageWorker({
      owner: "worker-a",
      repository: transientFake.repository,
      registry: new StageRegistry([{
        stage: "PARSE",
        implementationIdentity: parseIdentity,
        handler: async () => { throw new TransientStageError("STORE_TIMEOUT", "artifact store timed out"); },
      }]),
      retryPolicy: createRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 10_000 }),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      claimBatchSize: 1,
    });
    await transientWorker.runOnce();
    expect(transientFake.failed[0]).toMatchObject({
      classification: "transient",
      errorCode: "STORE_TIMEOUT",
      retryDelayMs: 1_000,
    });

    const deterministicFake = fakeRepository([claimed({ leaseOwner: "worker-b" })]);
    const deterministicWorker = new StageWorker({
      owner: "worker-b",
      repository: deterministicFake.repository,
      registry: new StageRegistry([{
        stage: "PARSE",
        implementationIdentity: parseIdentity,
        handler: async () => { throw new DeterministicStageError("INVALID_PDF", "invalid signature"); },
      }]),
      retryPolicy: createRetryPolicy(),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      claimBatchSize: 1,
    });
    await deterministicWorker.runOnce();
    expect(deterministicFake.failed[0]).toMatchObject({ classification: "deterministic", errorCode: "INVALID_PDF" });
  });

  test("invalid immutable ownership/input envelope fails closed before dispatch", async () => {
    const fake = fakeRepository([claimed({ inputChecksum: "not-a-checksum" })]);
    let handlerCalls = 0;
    const worker = new StageWorker({
      owner: "worker-a",
      repository: fake.repository,
      registry: new StageRegistry([{
        stage: "PARSE",
        implementationIdentity: parseIdentity,
        handler: async () => { handlerCalls += 1; return { outputRef: "artifact://parsed", outputChecksum: checksum("2") }; },
      }]),
      retryPolicy: createRetryPolicy(),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      claimBatchSize: 1,
    });

    await worker.runOnce();
    expect(handlerCalls).toBe(0);
    expect(fake.failed[0]).toMatchObject({ classification: "deterministic", errorCode: "INVALID_STAGE_ENVELOPE" });
  });

  test("slow heartbeats never overlap", async () => {
    const fake = fakeRepository();
    let heartbeatInFlight = 0;
    let maximumHeartbeatConcurrency = 0;
    fake.repository.heartbeat = async () => {
      heartbeatInFlight += 1;
      maximumHeartbeatConcurrency = Math.max(maximumHeartbeatConcurrency, heartbeatInFlight);
      await Bun.sleep(20);
      heartbeatInFlight -= 1;
      return true;
    };
    const worker = new StageWorker({
      owner: "worker-a",
      repository: fake.repository,
      registry: new StageRegistry([{
        stage: "PARSE",
        implementationIdentity: parseIdentity,
        handler: async () => {
          await Bun.sleep(55);
          return { outputRef: "artifact://parsed", outputChecksum: checksum("2") };
        },
      }]),
      retryPolicy: createRetryPolicy(),
      leaseDurationMs: 100,
      heartbeatIntervalMs: 5,
      claimBatchSize: 1,
    });

    await worker.runOnce();
    await Bun.sleep(25);
    expect(maximumHeartbeatConcurrency).toBe(1);
  });

  test("graceful stop blocks new claims and releases unfinished leases", async () => {
    const fake = fakeRepository();
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    const registry = new StageRegistry([{
      stage: "PARSE",
      implementationIdentity: parseIdentity,
      handler: async ({ signal }) => {
        started();
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { outputRef: "artifact://never", outputChecksum: checksum("2") };
      },
    }]);
    const worker = new StageWorker({
      owner: "worker-a",
      repository: fake.repository,
      registry,
      retryPolicy: createRetryPolicy(),
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
      claimBatchSize: 1,
    });

    const running = worker.runOnce();
    await handlerStarted;
    await worker.stop({ gracePeriodMs: 0 });
    await running;
    expect(fake.released).toHaveLength(1);
    expect(await worker.runOnce()).toBe(0);
  });
});

describe("retry classification", () => {
  test("common network, timeout, rate-limit, and storage SDK failures are transient", () => {
    const policy = createRetryPolicy();
    const coded = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const http = Object.assign(new Error("upstream unavailable"), { status: 503 });
    const sdk = Object.assign(new Error("storage throttled"), { $metadata: { httpStatusCode: 429 } });

    expect(policy.classify(new DOMException("request aborted", "AbortError")).classification).toBe("transient");
    expect(policy.classify(coded)).toMatchObject({ classification: "transient", errorCode: "ECONNRESET" });
    expect(policy.classify(http).classification).toBe("transient");
    expect(policy.classify(sdk).classification).toBe("transient");
    expect(policy.classify(Object.assign(new Error("connector timed out"), {
      code: "FETCH_TIMEOUT",
      classification: "transient",
    }))).toMatchObject({ classification: "transient", errorCode: "FETCH_TIMEOUT" });
    expect(policy.classify(new Error("schema validation failed")).classification).toBe("deterministic");
  });
});

describe("stage implementation identity", () => {
  test("configuration drift derives a different compatibility identity", () => {
    const baseline = deriveStageImplementationVersion(parseIdentity);
    expect(deriveStageImplementationVersion({ configChecksum: checksum("e") })).not.toBe(baseline);
    expect(baseline).toMatch(/^stage-v1:[0-9a-f]{64}$/);
    expect(() => deriveStageImplementationVersion({ configChecksum: "not-a-sha256" })).toThrow("SHA-256");
  });
});

describe("discovery scheduler controls", () => {
  test("tick is bounded and operator trigger/pause/resume delegate without starting external fetch", async () => {
    const claimedRuns = [{ id: "discovery-1" }, { id: "discovery-2" }];
    const calls: string[] = [];
    const scheduler = new DiscoveryScheduler({
      maxClaimsPerTick: 2,
      store: {
        claimDue: async () => claimedRuns.shift() ?? null,
        trigger: async (sourceId) => { calls.push(`trigger:${sourceId}`); return { id: "manual-1" }; },
        pause: async (sourceId) => { calls.push(`pause:${sourceId}`); return true; },
        resume: async (sourceId) => { calls.push(`resume:${sourceId}`); return true; },
      },
    });

    expect(await scheduler.tick()).toHaveLength(2);
    expect(await scheduler.manualTrigger("source-1")).toEqual({ id: "manual-1" });
    expect(await scheduler.pause("source-1")).toBe(true);
    expect(await scheduler.resume("source-1")).toBe(true);
    expect(calls).toEqual(["trigger:source-1", "pause:source-1", "resume:source-1"]);
  });

  test("source acquisition runs through its own fenced discovery worker contract", async () => {
    const completed: unknown[] = [];
    const failed: unknown[] = [];
    const repository: DiscoveryExecutionRepository = {
      claim: async () => [{
        id: "discovery-1",
        sourceId: "source-1",
        configRevisionId: "config-1",
        scheduledFor: new Date("2026-08-04T10:00:00.000Z"),
        attemptCount: 1,
        leaseOwner: "discovery-worker",
        leaseEpoch: 1,
      }],
      heartbeat: async () => true,
      complete: async (input) => { completed.push(input); return true; },
      fail: async (input) => { failed.push(input); return true; },
      release: async () => true,
    };
    const worker = new DiscoveryWorker({
      owner: "discovery-worker",
      repository,
      handler: async ({ sourceId }) => expect(sourceId).toBe("source-1"),
      retryPolicy: createRetryPolicy(),
      claimBatchSize: 1,
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 20_000,
    });

    expect(await worker.runOnce()).toBe(1);
    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });
});
