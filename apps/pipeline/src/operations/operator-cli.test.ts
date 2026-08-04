import { describe, expect, test } from "bun:test";

import { artifactStoreFromEnvironment } from "./artifact-store-config.ts";
import { PipelineHealth } from "./health.ts";
import { PipelineMetrics, structuredPipelineLog } from "./metrics.ts";
import {
  runOperatorCli,
  type PipelineOperatorRepository,
  type PipelineOperatorStatus,
} from "./operator-cli.ts";

const EMPTY_STATUS: PipelineOperatorStatus = {
  sources: [],
  queue: { pending: 0, running: 0, retries: 0, deadLetters: 0, waitingReview: 0, publicationLag: 0 },
};

function fakeRepository(calls: unknown[]): PipelineOperatorRepository {
  return {
    status: async () => EMPTY_STATUS,
    triggerSource: async (sourceId) => {
      calls.push(["trigger-source", sourceId]);
      return { id: "manual-discovery-1" };
    },
    pauseSource: async (sourceId) => { calls.push(["pause", sourceId]); return true; },
    resumeSource: async (sourceId) => { calls.push(["resume", sourceId]); return true; },
    freezeSource: async (sourceId, reason) => { calls.push(["freeze-source", sourceId, reason]); return true; },
    freezeAccessScope: async (scopeId, reason) => { calls.push(["freeze-scope", scopeId, reason]); return true; },
    requeueStage: async (input) => { calls.push(["requeue-stage", input]); return { id: "new-stage" }; },
    requeueDiscovery: async (input) => { calls.push(["requeue-discovery", input]); return { id: "new-discovery" }; },
    reactivateGeneration: async (input) => {
      calls.push(["reactivate-generation", input]);
      return { generationId: input.targetGenerationId, replacedGenerationId: input.currentGenerationId };
    },
  };
}

describe("pipeline operations", () => {
  test("production artifact configuration fails closed", () => {
    expect(() => artifactStoreFromEnvironment({ NODE_ENV: "production", ARTIFACT_STORE: "filesystem", ARTIFACT_FILESYSTEM_ROOT: "/tmp/artifacts" }))
      .toThrow("Production pipeline requires ARTIFACT_STORE=s3");
    expect(() => artifactStoreFromEnvironment({
      NODE_ENV: "production",
      ARTIFACT_STORE: "s3",
      ARTIFACT_S3_BUCKET: "bucket",
      ARTIFACT_S3_REGION: "ap-south-1",
      ARTIFACT_S3_CREDENTIALS_MODE: "ambient",
    })).toThrow("ARTIFACT_S3_ENDPOINT is required");
    expect(() => artifactStoreFromEnvironment({
      NODE_ENV: "production",
      ARTIFACT_STORE: "s3",
      ARTIFACT_S3_BUCKET: "bucket",
      ARTIFACT_S3_REGION: "ap-south-1",
      ARTIFACT_S3_ENDPOINT: "https://s3.example.invalid",
      ARTIFACT_S3_CREDENTIALS_MODE: "static",
    })).toThrow("AWS_ACCESS_KEY_ID is required");
  });

  test("readiness checks dependencies while liveness tracks claim-loop progress", async () => {
    const health = new PipelineHealth("stage-worker", [
      { name: "postgres", check: async () => undefined },
      { name: "artifact_store", check: async () => { throw new Error("unavailable"); } },
    ], 1_000);
    expect(health.liveness().ok).toBe(true);
    expect(await health.readiness()).toEqual({
      ok: false,
      role: "stage-worker",
      state: "not_ready",
      checks: { postgres: "ok", artifact_store: "failed" },
    });
    health.markClaimLoopStopped();
    expect(health.liveness().state).toBe("not_live");
  });

  test("metrics and logs expose opaque lineage but reject URLs, content, and secrets", () => {
    const metrics = new PipelineMetrics();
    metrics.increment("pipeline_retries_total", { source_id: "source-1", stage: "PARSE" });
    metrics.increment("pipeline_dead_letters_total", { source_id: "source-1", stage: "PARSE" });
    metrics.increment("pipeline_lease_recoveries_total", { source_id: "source-1" });
    metrics.set("pipeline_review_backlog", 1, { access_scope: "910" });
    metrics.set("pipeline_publication_lag_seconds", 5, { source_id: "source-1" });
    const rendered = metrics.render();
    expect(rendered).toContain("pipeline_retries_total");
    expect(rendered).not.toContain("https://");
    expect(() => metrics.set("pipeline_queue_age_seconds", 1, { source_url: "https://secret.example/x?token=a" }))
      .toThrow("Sensitive or invalid metric label");
    expect(() => structuredPipelineLog("info", "stage.complete", { correlationId: "corr-1" }, { rawText: "private" }))
      .toThrow("Sensitive pipeline log field");
    expect(JSON.parse(structuredPipelineLog("info", "stage.complete", {
      correlationId: "corr-1",
      sourceId: "source-1",
      documentVersionId: "version-1",
      pipelineRunId: "run-1",
      stageAttemptId: "attempt-1",
    })).sourceId).toBe("source-1");
  });

  test("operator controls keep normal pause separate from emergency freeze", async () => {
    const calls: unknown[] = [];
    const repository = fakeRepository(calls);
    await runOperatorCli(["pause-source", "--source-id", "source-1"], repository);
    await runOperatorCli(["freeze-scope", "--access-scope-id", "scope-1", "--reason", "incident-42"], repository);
    await runOperatorCli(["unfreeze-scope", "--access-scope-id", "scope-1"], repository);
    expect(calls).toEqual([
      ["pause", "source-1"],
      ["freeze-scope", "scope-1", "incident-42"],
      ["freeze-scope", "scope-1", null],
    ]);
  });

  test("manual source trigger creates one durable run without enabling cadence", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];

    await runOperatorCli([
      "trigger-source",
      "--source-id", "source-1",
    ], fakeRepository(calls), (value) => output.push(value));

    expect(calls).toEqual([["trigger-source", "source-1"]]);
    expect(output).toEqual([JSON.stringify({ discoveryRunId: "manual-discovery-1" })]);
  });

  test("stage requeue requires checksum and immutable ownership guards", async () => {
    const calls: unknown[] = [];
    const repository = fakeRepository(calls);
    await expect(runOperatorCli([
      "requeue-stage",
      "--attempt-id", "attempt-1",
      "--operator", "ops@example.com",
    ], repository)).rejects.toThrow("--expected-input-checksum is required");
    const checksum = "a".repeat(64);
    await runOperatorCli([
      "requeue-stage",
      "--attempt-id", "attempt-1",
      "--operator", "ops@example.com",
      "--expected-input-checksum", checksum,
      "--expected-access-scope-id", "scope-1",
      "--expected-source-id", "source-1",
      "--expected-document-version-id", "version-1",
    ], repository);
    expect(calls).toEqual([["requeue-stage", {
      attemptId: "attempt-1",
      operator: "ops@example.com",
      expectedInputChecksum: checksum,
      expectedAccessScopeId: "scope-1",
      expectedSourceId: "source-1",
      expectedDocumentVersionId: "version-1",
    }]]);
  });

  test("discovery requeue requires source and immutable config revision", async () => {
    const calls: unknown[] = [];
    const repository = fakeRepository(calls);
    await runOperatorCli([
      "requeue-discovery",
      "--discovery-run-id", "discovery-1",
      "--operator", "ops@example.com",
      "--expected-source-id", "source-1",
      "--expected-config-revision-id", "revision-1",
    ], repository);
    expect(calls).toHaveLength(1);
  });

  test("prior-generation reactivation requires exact ownership and incident lineage", async () => {
    const calls: unknown[] = [];
    await runOperatorCli([
      "reactivate-generation",
      "--source-document-id", "document-1",
      "--current-generation-id", "generation-2",
      "--target-generation-id", "generation-1",
      "--expected-access-scope-id", "scope-1",
      "--expected-source-id", "source-1",
      "--operator", "ops@example.com",
      "--incident-id", "incident-42",
    ], fakeRepository(calls));
    expect(calls).toEqual([["reactivate-generation", {
      sourceDocumentId: "document-1",
      currentGenerationId: "generation-2",
      targetGenerationId: "generation-1",
      expectedAccessScopeId: "scope-1",
      expectedSourceId: "source-1",
      actor: "ops@example.com",
      incidentId: "incident-42",
    }]]);
  });
});
