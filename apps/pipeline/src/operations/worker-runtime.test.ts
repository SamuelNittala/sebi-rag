import { describe, expect, test } from "bun:test";

import type { Database } from "@mf-rag/db";

import type { ArtifactStore } from "../artifacts/artifact-store.ts";
import { validateWorkerModuleUrl } from "./process-role.ts";
import {
  createWorkerRuntime,
  loadImmutableWorkerRuntimeConfig,
  parseIdentity,
  verifyDoclingParserVersion,
  verifyEmbeddingModelAvailable,
} from "./worker-runtime.ts";

const DOCLING_VERSION = "docling-2.132.0+norm-1+opts-3f9a1c2b7d10";

const checksum = (value: string) => value.repeat(64);

function environment(): Record<string, string> {
  return {
    PIPELINE_WORKER_ID: "worker-fixture-1",
    PIPELINE_RELEASE_DIGEST: `sha256:${checksum("a")}`,
    PIPELINE_CONFIG_CHECKSUM: checksum("b"),
    PIPELINE_PARSER_VERSION: "parser-v1",
    PIPELINE_TABLE_EXTRACTOR_VERSION: "tables-v1",
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
  test("fails closed on missing immutable identity or embedding model", () => {
    const missingChecksum = environment();
    delete missingChecksum.PIPELINE_CONFIG_CHECKSUM;
    expect(() => loadImmutableWorkerRuntimeConfig(missingChecksum)).toThrow("PIPELINE_CONFIG_CHECKSUM");

    const invalidChecksum = environment();
    invalidChecksum.PIPELINE_CONFIG_CHECKSUM = "not-a-sha256";
    expect(() => loadImmutableWorkerRuntimeConfig(invalidChecksum)).toThrow("SHA-256");

    const missingRelease = environment();
    delete missingRelease.PIPELINE_RELEASE_DIGEST;
    expect(() => loadImmutableWorkerRuntimeConfig(missingRelease)).toThrow("PIPELINE_RELEASE_DIGEST");

    const invalidRelease = environment();
    invalidRelease.PIPELINE_RELEASE_DIGEST = "latest";
    expect(() => loadImmutableWorkerRuntimeConfig(invalidRelease)).toThrow("sha256");

    const missingChunkVersion = environment();
    delete missingChunkVersion.PIPELINE_CHUNK_COMPONENT_VERSION;
    expect(() => loadImmutableWorkerRuntimeConfig(missingChunkVersion)).toThrow("PIPELINE_CHUNK_COMPONENT_VERSION");

    const missingModel = environment();
    delete missingModel.EMBEDDING_MODEL;
    expect(() => loadImmutableWorkerRuntimeConfig(missingModel)).toThrow("EMBEDDING_MODEL");
  });

  test("constructs both real role graphs without touching network or storage", async () => {
    const database = {} as Database;
    const artifactStore = {} as ArtifactStore;
    const verifyCurrentConfig = async () => {};
    const verifyEmbeddingModel = async () => {};
    const discovery = await createWorkerRuntime({ role: "discovery-worker", database, artifactStore }, environment(), {
      verifyCurrentConfig,
    });
    const stage = await createWorkerRuntime({ role: "stage-worker", database, artifactStore }, environment(), {
      verifyCurrentConfig,
      verifyEmbeddingModel,
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

  test("leaves Docling unconfigured by default and requires its version iff the URL is set", () => {
    const unset = loadImmutableWorkerRuntimeConfig(environment());
    expect(unset.doclingServiceUrl).toBeNull();
    expect(unset.doclingParserVersion).toBeNull();

    const configured = loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_SERVICE_URL: "http://docling:8090/",
      PIPELINE_DOCLING_PARSER_VERSION: DOCLING_VERSION,
    });
    expect(configured).toMatchObject({
      doclingServiceUrl: "http://docling:8090",
      doclingParserVersion: DOCLING_VERSION,
      doclingParseDeadlineMs: 1_800_000,
      doclingMaxResponseBytes: 50_000_000,
    });
    expect(loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_SERVICE_URL: "http://docling:8090",
      PIPELINE_DOCLING_PARSER_VERSION: DOCLING_VERSION,
      PIPELINE_DOCLING_PARSE_DEADLINE_MS: "60000",
      PIPELINE_DOCLING_MAX_RESPONSE_BYTES: "1000",
    })).toMatchObject({ doclingParseDeadlineMs: 60_000, doclingMaxResponseBytes: 1_000 });

    expect(() => loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_SERVICE_URL: "http://docling:8090",
    })).toThrow("PIPELINE_DOCLING_PARSER_VERSION");
    expect(() => loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_PARSER_VERSION: DOCLING_VERSION,
    })).toThrow("PIPELINE_DOCLING_SERVICE_URL");
    expect(() => loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_SERVICE_URL: "http://user:pass@docling:8090",
      PIPELINE_DOCLING_PARSER_VERSION: DOCLING_VERSION,
    })).toThrow("PIPELINE_DOCLING_SERVICE_URL");
  });

  test("parse identity is unchanged without Docling and changes with the Docling version", () => {
    const base = parseIdentity(loadImmutableWorkerRuntimeConfig(environment()));
    const docling = (version: string) => parseIdentity(loadImmutableWorkerRuntimeConfig({
      ...environment(),
      PIPELINE_DOCLING_SERVICE_URL: "http://docling:8090",
      PIPELINE_DOCLING_PARSER_VERSION: version,
    }));

    expect(base.componentVersion).toBe(parseIdentity(loadImmutableWorkerRuntimeConfig(environment())).componentVersion);
    expect(docling(DOCLING_VERSION).componentVersion).not.toBe(base.componentVersion);
    expect(docling("docling-2.133.0+norm-1+opts-3f9a1c2b7d10").componentVersion)
      .not.toBe(docling(DOCLING_VERSION).componentVersion);
  });

  test("stage startup verifies the Docling service parser version and fails closed on mismatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new URL(request.url).pathname === "/health"
        ? Response.json({ status: "ok", parserVersion: DOCLING_VERSION })
        : new Response("not found", { status: 404 }),
    });
    try {
      await expect(verifyDoclingParserVersion(server.url.href, DOCLING_VERSION)).resolves.toBeUndefined();
      await expect(verifyDoclingParserVersion(server.url.href, "docling-9.9.9+norm-1+opts-000000000000"))
        .rejects.toThrow(/PIPELINE_DOCLING_PARSER_VERSION/);

      const env = {
        ...environment(),
        PIPELINE_DOCLING_SERVICE_URL: server.url.href,
        PIPELINE_DOCLING_PARSER_VERSION: "docling-9.9.9+norm-1+opts-000000000000",
      };
      const overrides = {
        verifyCurrentConfig: async () => {},
        verifyEmbeddingModel: async () => {},
        publisher: { publish: async () => ({ generationId: crypto.randomUUID(), outputChecksum: checksum("c") }) },
      };
      const input = { role: "stage-worker" as const, database: {} as Database, artifactStore: {} as ArtifactStore };
      await expect(createWorkerRuntime(input, env, overrides)).rejects.toThrow(/PIPELINE_DOCLING_PARSER_VERSION/);
      await expect(createWorkerRuntime(input, { ...env, PIPELINE_DOCLING_PARSER_VERSION: DOCLING_VERSION }, overrides))
        .resolves.toMatchObject({ role: "stage-worker" });
      // The discovery worker never calls the Docling service.
      await expect(createWorkerRuntime({ ...input, role: "discovery-worker" }, env, overrides))
        .resolves.toMatchObject({ role: "discovery-worker" });
    } finally {
      server.stop(true);
    }
    await expect(verifyDoclingParserVersion(server.url.href, DOCLING_VERSION)).rejects.toThrow();
  });

  test("requires the exact configured embedding model before stage claims", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ models: [{ name: "bge-m3:latest" }] }),
    });
    try {
      await expect(verifyEmbeddingModelAvailable(server.url.href, "bge-m3")).resolves.toBeUndefined();
      await expect(verifyEmbeddingModelAvailable(server.url.href, "other-model"))
        .rejects.toThrow(/not installed/i);
    } finally {
      server.stop(true);
    }
  });
});
