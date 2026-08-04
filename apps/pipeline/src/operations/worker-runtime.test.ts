import { describe, expect, test } from "bun:test";

import type { Database } from "@mf-rag/db";

import type { ArtifactStore } from "../artifacts/artifact-store.ts";
import { validateWorkerModuleUrl } from "./process-role.ts";
import {
  createWorkerRuntime,
  loadImmutableWorkerRuntimeConfig,
} from "./worker-runtime.ts";

const checksum = (value: string) => value.repeat(64);

function environment(): Record<string, string> {
  return {
    PIPELINE_WORKER_ID: "worker-fixture-1",
    PIPELINE_RELEASE_DIGEST: `sha256:${checksum("a")}`,
    PIPELINE_CONFIG_CHECKSUM: checksum("b"),
    PIPELINE_PARSER_VERSION: "pdf-parser-v1",
    PIPELINE_TABLE_EXTRACTOR_VERSION: "table-parser-v1",
    PIPELINE_FETCH_ARTIFACT_VERSION: "fetch-artifact-v1",
    PIPELINE_PARSE_ARTIFACT_VERSION: "parse-artifact-v1",
    PIPELINE_PARSE_COMPONENT_VERSION: "parse-component-v1",
    PIPELINE_CHUNK_COMPONENT_VERSION: "chunk-component-v1",
    PIPELINE_REVIEW_COMPONENT_VERSION: "review-component-v1",
    PIPELINE_PUBLISH_COMPONENT_VERSION: "publish-component-v1",
    PIPELINE_LEASE_DURATION_MS: "120000",
    PIPELINE_HEARTBEAT_INTERVAL_MS: "30000",
    PIPELINE_MAX_ATTEMPTS: "3",
    PIPELINE_CLAIM_BATCH_SIZE: "2",
    OLLAMA_BASE_URL: "http://ollama:11434",
    EMBEDDING_MODEL: "bge-m3",
    EMBEDDING_BATCH_SIZE: "10",
  };
}

describe("immutable pipeline worker composition", () => {
  test("fails closed on missing or mutable release/config/model identity", () => {
    const env = environment();
    delete env.PIPELINE_RELEASE_DIGEST;
    expect(() => loadImmutableWorkerRuntimeConfig(env)).toThrow("PIPELINE_RELEASE_DIGEST");

    const mutable = environment();
    mutable.PIPELINE_RELEASE_DIGEST = "latest";
    expect(() => loadImmutableWorkerRuntimeConfig(mutable)).toThrow("immutable");

    const missingModel = environment();
    delete missingModel.EMBEDDING_MODEL;
    expect(() => loadImmutableWorkerRuntimeConfig(missingModel)).toThrow("EMBEDDING_MODEL");
  });

  test("constructs both real role graphs without touching network or storage", async () => {
    const database = {} as Database;
    const artifactStore = {} as ArtifactStore;
    const verifyCurrentConfig = async () => {};
    const discovery = await createWorkerRuntime({ role: "discovery-worker", database, artifactStore }, environment(), {
      verifyCurrentConfig,
    });
    const stage = await createWorkerRuntime({ role: "stage-worker", database, artifactStore }, environment(), {
      verifyCurrentConfig,
      publisher: {
        publish: async () => ({ generationId: crypto.randomUUID(), outputChecksum: checksum("c") }),
      },
    });
    expect(discovery.role).toBe("discovery-worker");
    expect(stage.role).toBe("stage-worker");
    expect(discovery.runOnce).toBeFunction();
    expect(stage.stop).toBeFunction();
  });

  test("accepts only normalized immutable-image module paths", () => {
    expect(validateWorkerModuleUrl("file:///app/apps/pipeline/src/operations/worker-runtime.ts"))
      .toBe("file:///app/apps/pipeline/src/operations/worker-runtime.ts");
    expect(() => validateWorkerModuleUrl("file:///app/apps/pipeline/../../etc/worker.ts"))
      .toThrow(/below \/app\/apps|without traversal/);
    expect(() => validateWorkerModuleUrl("file:///app/apps/pipeline/worker.ts?module=other"))
      .toThrow(/query/);
    expect(() => validateWorkerModuleUrl("https://example.test/worker.ts"))
      .toThrow(/local file URL/);
  });
});
