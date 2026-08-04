import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createSourceKey,
  type DesiredSourceRegistry,
} from "@mf-rag/types";

import {
  cancelStageAttemptBeforeStart,
  claimDiscoveryExecutions,
  claimStageAttempts,
  completeStageAttempt,
  completeDiscoveryExecution,
  enqueueDocumentPipelineRun,
  failStageAttempt,
  failDiscoveryExecution,
  findCompatibleStageSuccess,
  heartbeatStageAttempt,
  pausePipelineRun,
  pauseSourceSchedule,
  heartbeatDiscoveryExecution,
  reuseCompatibleStageSuccess,
  requeueDeadLetterAttempt,
  releaseStageAttemptLease,
  requeueDeadLetterDiscoveryRun,
  resumePipelineRun,
  resumeSourceSchedule,
  setAccessScopeEmergencyFreeze,
  setSourceEmergencyFreeze,
  triggerManualDiscoveryRun,
} from "./pipeline-run-queries.ts";
import {
  findOrCreateSourceDocument,
  recordFetchedDocumentVersion,
} from "./document-version-queries.ts";
import { claimDueDiscoveryRun, reconcileSourceRegistry } from "./source-registry-queries.ts";
import * as schema from "./schema.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const INPUT_CHECKSUM = "1".repeat(64);
const OUTPUT_CHECKSUM = "2".repeat(64);

function registry(): DesiredSourceRegistry {
  return {
    version: 1,
    accessScopes: [{
      apiVersion: "mf-rag/v1",
      accessScopeKey: createAccessScopeKey("mirae-sif"),
      externalCode: createExternalAccessCode("910"),
      classification: {
        knowledgeDomain: "sif",
        sourceCollection: "mirae_sif",
        amcSlug: "mirae-asset",
      },
      sources: [{
        sourceKey: createSourceKey("documents"),
        connector: "website_pdf",
        enabled: true,
        discovery: { strategy: "explicit_urls", urls: [{
          key: "factsheet" as never,
          url: "https://example.com/factsheet.pdf",
        }] },
        schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
        fetch: {
          allowedHosts: ["example.com"],
          allowedPathPrefixes: ["/"],
          maxBytes: 10_000_000,
          timeoutMs: 30_000,
          maxRedirects: 3,
        },
        review: { policy: "risk_based" },
      }],
    }],
  };
}

integrationDescribe("fenced pipeline stage runtime", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });

  beforeEach(async () => {
    await db.delete(schema.stageAttempts);
    await db.delete(schema.pipelineRuns);
    await db.delete(schema.documentObservations);
    await db.update(schema.sourceDocuments).set({ currentVersionId: null });
    await db.delete(schema.documentVersions);
    await db.delete(schema.sourceDocumentUrlAliases);
    await db.delete(schema.sourceDocuments);
    await db.delete(schema.artifacts);
    await db.delete(schema.discoveryRuns);
    await db.delete(schema.sourceSchedules);
    await db.delete(schema.sources);
    await db.delete(schema.accessScopes);
    await db.delete(schema.sourceRegistryRevisions);
    await reconcileSourceRegistry(db, registry());
  });

  afterAll(async () => client.close());

  async function createPendingAttempt(maxAttempts = 3, pipelineVersion = "pipeline-v1") {
    const [scope] = await db.select().from(schema.accessScopes);
    const [source] = await db.select().from(schema.sources);
    const document = await findOrCreateSourceDocument(db, {
      accessScopeId: scope!.id,
      sourceId: source!.id,
      logicalDocumentKey: `factsheet-${crypto.randomUUID()}`,
      canonicalUrl: `https://example.com/${crypto.randomUUID()}.pdf`,
    });
    const hash = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const version = (await recordFetchedDocumentVersion(db, {
      sourceDocumentId: document.id,
      artifact: {
        key: `raw/${hash}`,
        uri: `s3://pipeline-test/raw/${hash}`,
        sha256: hash,
        byteSize: 100,
        mediaType: "application/pdf",
        producerVersion: "fetch-v1",
      },
    })).version;
    return enqueueDocumentPipelineRun(db, {
      documentVersionId: version.id,
      implementationVersion: pipelineVersion,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v1",
      inputChecksum: INPUT_CHECKSUM,
      maxAttempts,
    });
  }

  test("two workers claim one pending attempt", async () => {
    await createPendingAttempt();

    const [left, right] = await Promise.all([
      claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 }),
      claimStageAttempts(db, { owner: "worker-b", batchSize: 1, leaseDurationMs: 60_000 }),
    ]);

    expect([...left, ...right]).toHaveLength(1);
    expect([...left, ...right][0]?.leaseEpoch).toBe(1);
  });

  test("idempotent enqueue rejects drift in an existing run's initial input contract", async () => {
    const pending = await createPendingAttempt(3);
    await expect(enqueueDocumentPipelineRun(db, {
      documentVersionId: pending.run.documentVersionId,
      implementationVersion: pending.run.implementationVersion,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v2",
      inputChecksum: "9".repeat(64),
      maxAttempts: 5,
    })).rejects.toThrow("initial stage contract");
    await expect(enqueueDocumentPipelineRun(db, {
      documentVersionId: pending.run.documentVersionId,
      implementationVersion: pending.run.implementationVersion,
      initialStage: "CHUNK_AND_INSPECT",
      initialStageImplementationVersion: "chunk-v1",
      inputChecksum: INPUT_CHECKSUM,
      maxAttempts: 3,
    })).rejects.toThrow("initial stage contract");
    expect(await db.select().from(schema.pipelineRuns)).toHaveLength(1);
    expect(await db.select().from(schema.stageAttempts)).toHaveLength(1);
  });

  test("composite ownership constraints reject cross-source runs and cross-version attempts", async () => {
    const first = await createPendingAttempt();
    const [source] = await db.select().from(schema.sources);
    const [otherSource] = await db.insert(schema.sources).values({
      accessScopeId: source!.accessScopeId,
      sourceKey: "other-documents",
      connector: source!.connector,
      discoveryConfig: source!.discoveryConfig,
      fetchConfig: source!.fetchConfig,
      reviewConfig: source!.reviewConfig,
      enabled: false,
      configRevisionId: source!.configRevisionId,
    }).returning();
    await expect((async () => {
      await db.insert(schema.pipelineRuns).values({
        documentVersionId: first.run.documentVersionId,
        accessScopeId: first.run.accessScopeId,
        sourceId: otherSource!.id,
        implementationVersion: "invalid-owner-pipeline-v1",
        initialStage: "PARSE",
        initialStageImplementationVersion: "parse-v1",
        initialInputChecksum: INPUT_CHECKSUM,
        initialMaxAttempts: 3,
      });
    })()).rejects.toThrow();

    const second = await createPendingAttempt(3, "pipeline-v2");
    await expect((async () => {
      await db.insert(schema.stageAttempts).values({
        pipelineRunId: first.run.id,
        documentVersionId: second.run.documentVersionId,
        accessScopeId: first.run.accessScopeId,
        sourceId: first.run.sourceId,
        stage: "REVIEW_DECISION",
        implementationVersion: "review-v1",
        inputChecksum: INPUT_CHECKSUM,
      });
    })()).rejects.toThrow();
  });

  test("an expired lease is recovered with a higher epoch and rejects the stale owner", async () => {
    await createPendingAttempt();
    const now = new Date(Date.now() + 1_000);
    const [workerA] = await claimStageAttempts(db, {
      owner: "worker-a",
      now,
      batchSize: 1,
      leaseDurationMs: 1_000,
    });
    await expect(heartbeatStageAttempt(db, {
      attemptId: workerA!.id,
      owner: "worker-a",
      leaseEpoch: workerA!.leaseEpoch,
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 1_001),
    })).resolves.toBe(false);
    const [workerB] = await claimStageAttempts(db, {
      owner: "worker-b",
      now: new Date(now.getTime() + 1_001),
      batchSize: 1,
      leaseDurationMs: 60_000,
    });

    expect(workerB?.id).toBe(workerA?.id);
    expect(workerB?.leaseEpoch).toBe(2);
    await expect(heartbeatStageAttempt(db, {
      attemptId: workerA!.id,
      owner: "worker-a",
      leaseEpoch: workerA!.leaseEpoch,
      leaseDurationMs: 60_000,
    })).resolves.toBe(false);
    await expect(completeStageAttempt(db, {
      attemptId: workerA!.id,
      owner: "worker-a",
      leaseEpoch: workerA!.leaseEpoch,
      outputRef: "artifact://stale",
      outputChecksum: OUTPUT_CHECKSUM,
    })).resolves.toMatchObject({ accepted: false });

    await completeStageAttempt(db, {
      attemptId: workerB!.id,
      owner: "worker-b",
      leaseEpoch: workerB!.leaseEpoch,
      outputRef: "artifact://parsed",
      outputChecksum: OUTPUT_CHECKSUM,
      next: {
        stage: "CHUNK_AND_INSPECT",
        implementationVersion: "chunk-v1",
        inputChecksum: OUTPUT_CHECKSUM,
      },
    });
    await expect(completeStageAttempt(db, {
      attemptId: workerA!.id,
      owner: "worker-a",
      leaseEpoch: workerA!.leaseEpoch,
      outputRef: "artifact://stale-after-commit",
      outputChecksum: OUTPUT_CHECKSUM,
    })).resolves.toMatchObject({ accepted: false });
    expect(await db.select().from(schema.stageAttempts)).toHaveLength(2);
  });

  test("success lookup reuses a crash-after-commit result and next-stage insertion is exact once", async () => {
    const pending = await createPendingAttempt();
    const [claimed] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 });
    const completion = await completeStageAttempt(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
      outputRef: "artifact://parsed",
      outputChecksum: OUTPUT_CHECKSUM,
      next: {
        stage: "CHUNK_AND_INSPECT",
        implementationVersion: "chunk-v1",
        inputChecksum: OUTPUT_CHECKSUM,
      },
    });
    expect(completion.accepted).toBe(true);

    const reused = await findCompatibleStageSuccess(db, {
      documentVersionId: pending.run.documentVersionId,
      stage: "PARSE",
      implementationVersion: "parse-v1",
      inputChecksum: INPUT_CHECKSUM,
    });
    expect(reused?.outputRef).toBe("artifact://parsed");
    await expect(completeStageAttempt(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
      outputRef: "artifact://parsed",
      outputChecksum: OUTPUT_CHECKSUM,
      next: {
        stage: "CHUNK_AND_INSPECT",
        implementationVersion: "chunk-v1",
        inputChecksum: OUTPUT_CHECKSUM,
      },
    })).resolves.toMatchObject({ accepted: false });
    expect((await db.select().from(schema.stageAttempts)).filter((row) => row.stage === "CHUNK_AND_INSPECT")).toHaveLength(1);
  });

  test("a new pipeline lineage reuses one document-version compatible success", async () => {
    const first = await createPendingAttempt(3, "pipeline-v1");
    const [claimedFirst] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 });
    await completeStageAttempt(db, {
      attemptId: claimedFirst!.id,
      owner: "worker-a",
      leaseEpoch: claimedFirst!.leaseEpoch,
      outputRef: "artifact://parsed-once",
      outputChecksum: OUTPUT_CHECKSUM,
    });

    const second = await enqueueDocumentPipelineRun(db, {
      documentVersionId: first.run.documentVersionId,
      implementationVersion: "pipeline-v2",
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v1",
      inputChecksum: INPUT_CHECKSUM,
    });
    const [claimedSecond] = await claimStageAttempts(db, { owner: "worker-b", batchSize: 1, leaseDurationMs: 60_000 });
    const compatible = await findCompatibleStageSuccess(db, {
      documentVersionId: second.run.documentVersionId,
      stage: "PARSE",
      implementationVersion: "parse-v1",
      inputChecksum: INPUT_CHECKSUM,
    });
    expect(compatible?.id).toBe(claimedFirst!.id);

    const reused = await reuseCompatibleStageSuccess(db, {
      attemptId: claimedSecond!.id,
      owner: "worker-b",
      leaseEpoch: claimedSecond!.leaseEpoch,
      successfulAttemptId: compatible!.id,
      next: { stage: "CHUNK_AND_INSPECT", implementationVersion: "chunk-v1", inputChecksum: OUTPUT_CHECKSUM },
    });
    expect(reused.accepted).toBe(true);
    expect(reused.attempt?.status).toBe("reused");
    expect((await db.select().from(schema.stageAttempts)).filter((row) => row.status === "succeeded")).toHaveLength(1);
    expect((await db.select().from(schema.stageAttempts)).filter((row) => row.stage === "CHUNK_AND_INSPECT")).toHaveLength(1);
  });

  test("concurrent compatible completions persist one result and reuse it in the other lineage", async () => {
    const first = await createPendingAttempt(3, "pipeline-v1");
    const second = await enqueueDocumentPipelineRun(db, {
      documentVersionId: first.run.documentVersionId,
      implementationVersion: "pipeline-v2",
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v1",
      inputChecksum: INPUT_CHECKSUM,
    });
    const [claimedA, claimedB] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 2, leaseDurationMs: 60_000 });
    expect([claimedA, claimedB]).toHaveLength(2);

    const completions = await Promise.all([
      completeStageAttempt(db, {
        attemptId: claimedA!.id,
        owner: "worker-a",
        leaseEpoch: claimedA!.leaseEpoch,
        outputRef: "artifact://parsed-a",
        outputChecksum: OUTPUT_CHECKSUM,
        next: { stage: "CHUNK_AND_INSPECT", implementationVersion: "chunk-v1", inputChecksum: OUTPUT_CHECKSUM },
      }),
      completeStageAttempt(db, {
        attemptId: claimedB!.id,
        owner: "worker-a",
        leaseEpoch: claimedB!.leaseEpoch,
        outputRef: "artifact://parsed-b",
        outputChecksum: "3".repeat(64),
        next: { stage: "CHUNK_AND_INSPECT", implementationVersion: "chunk-v1", inputChecksum: "3".repeat(64) },
      }),
    ]);

    expect(completions.every((result) => result.accepted)).toBe(true);
    const attempts = await db.select().from(schema.stageAttempts);
    expect(attempts.filter((row) => row.status === "succeeded")).toHaveLength(1);
    expect(attempts.filter((row) => row.status === "reused")).toHaveLength(1);
    const successful = attempts.find((row) => row.status === "succeeded")!;
    const nextAttempts = attempts.filter((row) => row.stage === "CHUNK_AND_INSPECT");
    expect(nextAttempts).toHaveLength(2);
    expect(new Set(nextAttempts.map((row) => row.pipelineRunId)).size).toBe(2);
    expect(nextAttempts.every((row) => row.inputChecksum === successful.outputChecksum)).toBe(true);
  });

  test("deterministic failure terminates immediately without transient retry history", async () => {
    await createPendingAttempt(3);
    const [claimed] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 });
    const result = await failStageAttempt(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
      errorCode: "INVALID_PDF",
      errorMessage: "signature mismatch",
      classification: "deterministic",
    });

    expect(result.disposition).toBe("DETERMINISTIC_FAILURE");
    expect(await db.select().from(schema.stageAttempts)).toHaveLength(1);
  });

  test("transient failure records a new backoff attempt and later success creates one next stage", async () => {
    await createPendingAttempt(3);
    const now = new Date(Date.now() + 1_000);
    const [claimed] = await claimStageAttempts(db, { owner: "worker-a", now, batchSize: 1, leaseDurationMs: 60_000 });
    const failed = await failStageAttempt(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
      errorCode: "ARTIFACT_STORE_TIMEOUT",
      errorMessage: "timed out",
      classification: "transient",
      now,
      retryDelayMs: 5_000,
    });
    expect(failed.disposition).toBe("RETRY_SCHEDULED");
    expect(await db.select().from(schema.stageAttempts)).toHaveLength(2);
    expect(await claimStageAttempts(db, {
      owner: "worker-b",
      now: new Date(now.getTime() + 4_999),
      batchSize: 1,
      leaseDurationMs: 60_000,
    })).toHaveLength(0);

    const [retry] = await claimStageAttempts(db, {
      owner: "worker-b",
      now: new Date(now.getTime() + 5_000),
      batchSize: 1,
      leaseDurationMs: 60_000,
    });
    await completeStageAttempt(db, {
      attemptId: retry!.id,
      owner: "worker-b",
      leaseEpoch: retry!.leaseEpoch,
      outputRef: "artifact://parsed",
      outputChecksum: OUTPUT_CHECKSUM,
      next: { stage: "CHUNK_AND_INSPECT", implementationVersion: "chunk-v1", inputChecksum: OUTPUT_CHECKSUM },
    });
    expect((await db.select().from(schema.stageAttempts)).filter((row) => row.stage === "CHUNK_AND_INSPECT")).toHaveLength(1);
  });

  test("retry exhaustion dead-letters work and requeue preserves immutable ownership and input", async () => {
    await createPendingAttempt(1);
    const [claimed] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 });
    const failed = await failStageAttempt(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
      errorCode: "STORAGE_UNAVAILABLE",
      errorMessage: "still unavailable",
      classification: "transient",
    });
    expect(failed.disposition).toBe("DEAD_LETTER");
    const dead = (await db.select().from(schema.stageAttempts))[0]!;

    await expect(requeueDeadLetterAttempt(db, {
      attemptId: dead.id,
      operator: "ops@example.com",
      expectedInputChecksum: "f".repeat(64),
      expectedAccessScopeId: dead.accessScopeId,
      expectedSourceId: dead.sourceId,
      expectedDocumentVersionId: dead.documentVersionId,
    })).rejects.toThrow("checksum or immutable ownership changed");
    const requeued = await requeueDeadLetterAttempt(db, {
      attemptId: dead.id,
      operator: "ops@example.com",
      expectedInputChecksum: dead.inputChecksum,
      expectedAccessScopeId: dead.accessScopeId,
      expectedSourceId: dead.sourceId,
      expectedDocumentVersionId: dead.documentVersionId,
    });
    expect(requeued.inputChecksum).toBe(dead.inputChecksum);
    expect(requeued.accessScopeId).toBe(dead.accessScopeId);
    expect(requeued.sourceId).toBe(dead.sourceId);
    expect(requeued.documentVersionId).toBe(dead.documentVersionId);
    expect(requeued.leaseEpoch).toBeGreaterThan(dead.leaseEpoch);
  });

  test("pause, resume, cancel-before-start, and graceful lease release are fenced", async () => {
    const pending = await createPendingAttempt();
    await pausePipelineRun(db, pending.run.id);
    expect(await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 })).toHaveLength(0);
    expect(await resumePipelineRun(db, pending.run.id)).toBe(true);
    expect(await resumePipelineRun(db, pending.run.id)).toBe(false);
    const [claimed] = await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 });
    expect(await releaseStageAttemptLease(db, {
      attemptId: claimed!.id,
      owner: "worker-a",
      leaseEpoch: claimed!.leaseEpoch,
    })).toBe(true);
    const [reclaimed] = await claimStageAttempts(db, { owner: "worker-b", batchSize: 1, leaseDurationMs: 60_000 });
    expect(reclaimed?.leaseEpoch).toBeGreaterThan(claimed!.leaseEpoch);

    await releaseStageAttemptLease(db, { attemptId: reclaimed!.id, owner: "worker-b", leaseEpoch: reclaimed!.leaseEpoch });
    expect(await cancelStageAttemptBeforeStart(db, reclaimed!.id, "operator requested cancellation")).toBe(true);
    const [cancelledRun] = await db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, pending.run.id));
    expect(cancelledRun?.status).toBe("cancelled");
    expect(await claimStageAttempts(db, { owner: "worker-c", batchSize: 1, leaseDurationMs: 60_000 })).toHaveLength(0);
  });

  test("downtime creates one catch-up discovery run and advances to a future cadence", async () => {
    const now = new Date("2026-08-04T10:30:00.000Z");
    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-01T00:00:00.000Z") });
    const [left, right] = await Promise.all([
      claimDueDiscoveryRun(db, { now }),
      claimDueDiscoveryRun(db, { now }),
    ]);

    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(schema.discoveryRuns)).toHaveLength(1);
    const [schedule] = await db.select().from(schema.sourceSchedules);
    expect(schedule!.nextDueAt.getTime()).toBeGreaterThan(now.getTime());
  });

  test("manual discovery and source pause/resume use durable PostgreSQL controls", async () => {
    const [source] = await db.select().from(schema.sources);
    expect(await pauseSourceSchedule(db, source!.id)).toBe(true);
    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-01T00:00:00.000Z") });
    expect(await claimDueDiscoveryRun(db, { now: new Date("2026-08-04T10:30:00.000Z") })).toBeNull();

    await expect(triggerManualDiscoveryRun(db, {
      sourceId: source!.id,
      now: new Date("2026-08-04T10:31:00.000Z"),
    })).rejects.toThrow("paused source");

    expect(await resumeSourceSchedule(db, source!.id)).toBe(true);
    expect(await resumeSourceSchedule(db, source!.id)).toBe(false);
    const manual = await triggerManualDiscoveryRun(db, {
      sourceId: source!.id,
      now: new Date("2026-08-04T10:31:00.000Z"),
    });
    expect(manual.sourceId).toBe(source!.id);
    expect(manual.status).toBe("pending");
    await db.update(schema.discoveryRuns).set({ status: "succeeded" }).where(eq(schema.discoveryRuns.id, manual.id));

    expect(await claimDueDiscoveryRun(db, { now: new Date("2026-08-04T10:32:00.000Z") })).not.toBeNull();

    await db.update(schema.discoveryRuns).set({ status: "succeeded" });
    await db.update(schema.sources).set({ enabled: false }).where(eq(schema.sources.id, source!.id));
    await expect(triggerManualDiscoveryRun(db, { sourceId: source!.id })).rejects.toThrow("disabled source");
    await db.update(schema.sources).set({ enabled: true }).where(eq(schema.sources.id, source!.id));
    await db.update(schema.accessScopes).set({ enabled: false }).where(eq(schema.accessScopes.id, source!.accessScopeId));
    await expect(triggerManualDiscoveryRun(db, { sourceId: source!.id })).rejects.toThrow("disabled access scope");
  });

  test("emergency freeze blocks scheduler, manual discovery, discovery claims, and stage claims", async () => {
    const pending = await createPendingAttempt();
    const [source] = await db.select().from(schema.sources);
    const [scope] = await db.select().from(schema.accessScopes);
    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-01T00:00:00.000Z") });

    expect(await setSourceEmergencyFreeze(db, { sourceId: source!.id, reason: "incident-1" })).toBe(true);
    expect(await claimStageAttempts(db, { owner: "worker-a", batchSize: 1, leaseDurationMs: 60_000 })).toHaveLength(0);
    expect(await claimDueDiscoveryRun(db, { now: new Date("2026-08-04T10:30:00.000Z") })).toBeNull();
    await expect(triggerManualDiscoveryRun(db, { sourceId: source!.id })).rejects.toThrow("emergency-frozen source");

    await setSourceEmergencyFreeze(db, { sourceId: source!.id, reason: null });
    await setAccessScopeEmergencyFreeze(db, { accessScopeId: scope!.id, reason: "incident-2" });
    expect(await claimStageAttempts(db, { owner: "worker-b", batchSize: 1, leaseDurationMs: 60_000 })).toHaveLength(0);
    await expect(triggerManualDiscoveryRun(db, { sourceId: source!.id })).rejects.toThrow("emergency-frozen access scope");

    await setAccessScopeEmergencyFreeze(db, { accessScopeId: scope!.id, reason: null });
    const [claimed] = await claimStageAttempts(db, { owner: "worker-c", batchSize: 1, leaseDurationMs: 60_000 });
    expect(claimed?.pipelineRunId).toBe(pending.run.id);
  });

  test("discovery execution claims are concurrent-safe and stale owners are fenced", async () => {
    const [source] = await db.select().from(schema.sources);
    const now = new Date("2026-08-04T11:00:00.000Z");
    await triggerManualDiscoveryRun(db, { sourceId: source!.id, now });
    const [left, right] = await Promise.all([
      claimDiscoveryExecutions(db, { owner: "discovery-a", batchSize: 1, leaseDurationMs: 1_000, now }),
      claimDiscoveryExecutions(db, { owner: "discovery-b", batchSize: 1, leaseDurationMs: 1_000, now }),
    ]);
    const [workerA] = [...left, ...right];
    expect([...left, ...right]).toHaveLength(1);

    const expiredAt = new Date(now.getTime() + 1_001);
    expect(await heartbeatDiscoveryExecution(db, {
      discoveryRunId: workerA!.id,
      owner: workerA!.leaseOwner!,
      leaseEpoch: workerA!.leaseEpoch,
      leaseDurationMs: 1_000,
      now: expiredAt,
    })).toBe(false);
    const [workerB] = await claimDiscoveryExecutions(db, {
      owner: "discovery-recovery",
      batchSize: 1,
      leaseDurationMs: 60_000,
      now: expiredAt,
    });
    expect(workerB?.leaseEpoch).toBe(workerA!.leaseEpoch + 1);
    expect(await completeDiscoveryExecution(db, {
      discoveryRunId: workerA!.id,
      owner: workerA!.leaseOwner!,
      leaseEpoch: workerA!.leaseEpoch,
      now: expiredAt,
    })).toBe(false);
    expect(await completeDiscoveryExecution(db, {
      discoveryRunId: workerB!.id,
      owner: "discovery-recovery",
      leaseEpoch: workerB!.leaseEpoch,
      now: expiredAt,
    })).toBe(true);
    expect(await completeDiscoveryExecution(db, {
      discoveryRunId: workerA!.id,
      owner: workerA!.leaseOwner!,
      leaseEpoch: workerA!.leaseEpoch,
      now: expiredAt,
    })).toBe(false);
  });

  test("discovery retries back off, dead-letter, and requeue without changing source input", async () => {
    const [source] = await db.select().from(schema.sources);
    const now = new Date("2026-08-04T12:00:00.000Z");
    const run = await triggerManualDiscoveryRun(db, { sourceId: source!.id, now });
    await db.update(schema.discoveryRuns).set({ maxAttempts: 2 }).where(eq(schema.discoveryRuns.id, run.id));
    const [claimed] = await claimDiscoveryExecutions(db, {
      owner: "discovery-a",
      batchSize: 1,
      leaseDurationMs: 60_000,
      now,
    });
    const failed = await failDiscoveryExecution(db, {
      discoveryRunId: claimed!.id,
      owner: "discovery-a",
      leaseEpoch: claimed!.leaseEpoch,
      classification: "transient",
      errorCode: "NETWORK_TIMEOUT",
      errorMessage: "source timed out",
      retryDelayMs: 5_000,
      now,
    });
    expect(failed.disposition).toBe("RETRY_SCHEDULED");
    expect((await triggerManualDiscoveryRun(db, { sourceId: source!.id, now })).id).toBe(run.id);
    expect(await claimDiscoveryExecutions(db, {
      owner: "too-early",
      batchSize: 1,
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 4_999),
    })).toHaveLength(0);
    const [retry] = await claimDiscoveryExecutions(db, {
      owner: "discovery-b",
      batchSize: 1,
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 5_000),
    });
    const exhausted = await failDiscoveryExecution(db, {
      discoveryRunId: retry!.id,
      owner: "discovery-b",
      leaseEpoch: retry!.leaseEpoch,
      classification: "transient",
      errorCode: "NETWORK_TIMEOUT",
      errorMessage: "source still timed out",
      retryDelayMs: 5_000,
      now: new Date(now.getTime() + 5_000),
    });
    expect(exhausted.disposition).toBe("DEAD_LETTER");
    const [dead] = await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, run.id));
    expect(dead?.retryHistory).toHaveLength(2);

    await expect(requeueDeadLetterDiscoveryRun(db, {
      discoveryRunId: run.id,
      operator: "ops@example.com",
      expectedSourceId: run.sourceId,
      expectedConfigRevisionId: crypto.randomUUID(),
      now,
    })).rejects.toThrow("ownership or configuration changed");
    const requeued = await requeueDeadLetterDiscoveryRun(db, {
      discoveryRunId: run.id,
      operator: "ops@example.com",
      expectedSourceId: run.sourceId,
      expectedConfigRevisionId: run.configRevisionId,
      now,
    });
    expect(requeued.sourceId).toBe(run.sourceId);
    expect(requeued.scheduledFor).toEqual(run.scheduledFor);
    expect(requeued.status).toBe("pending");
    expect(requeued.leaseEpoch).toBeGreaterThan(dead!.leaseEpoch);
  });
});
