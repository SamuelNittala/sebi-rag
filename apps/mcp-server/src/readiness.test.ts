import { describe, expect, test } from "bun:test";

import { checkReadiness } from "./readiness.ts";

describe("checkReadiness", () => {
  test("requires embedding, pgvector, and configured reranker", async () => {
    const readiness = await checkReadiness({
      embedder: { checkHealth: async () => true },
      vectorClient: { collectionExists: async () => true },
      reranker: { checkHealth: async () => false },
    } as never);

    expect(readiness).toEqual({
      status: "error",
      services: { embedding: true, pgvector: true, reranker: false },
    });
  });

  test("is ready without an unconfigured reranker", async () => {
    const readiness = await checkReadiness({
      embedder: { checkHealth: async () => true },
      vectorClient: { collectionExists: async () => true },
      reranker: null,
    } as never);

    expect(readiness).toEqual({
      status: "ok",
      services: { embedding: true, pgvector: true },
    });
  });

  test("fails readiness rather than waiting indefinitely for a dependency", async () => {
    const readiness = await checkReadiness({
      embedder: { checkHealth: () => new Promise<boolean>(() => {}) },
      vectorClient: { collectionExists: async () => true },
      reranker: null,
      timeoutMs: 1,
    } as never);

    expect(readiness).toEqual({
      status: "error",
      services: { embedding: false, pgvector: true },
    });
  });
});
