import { describe, expect, test } from "bun:test";

import {
  createRerankerFromEnv,
  resolveDenseScoreThreshold,
  resolveRerankCandidateLimit,
} from "./retrieval-config.ts";

describe("resolveDenseScoreThreshold", () => {
  test("defaults to 0.3 when no override is configured", () => {
    expect(resolveDenseScoreThreshold(undefined)).toBe(0.3);
  });

  test("accepts a configured similarity threshold", () => {
    expect(resolveDenseScoreThreshold("0.4")).toBe(0.4);
  });

  test.each(["", "invalid", "-0.1", "1.1"])(
    "falls back to 0.3 for %s",
    (value) => {
      expect(resolveDenseScoreThreshold(value)).toBe(0.3);
    },
  );
});

describe("reranker configuration", () => {
  test("enables the BGE reranker when its TEI endpoint is available", () => {
    const reranker = createRerankerFromEnv({
      RERANK_BASE_URL: "http://reranker:80",
    });

    expect(reranker).toMatchObject({
      provider: "tei",
      model: "BAAI/bge-reranker-v2-m3",
    });
  });

  test("stays disabled when no provider or endpoint is configured", () => {
    expect(createRerankerFromEnv({})).toBeNull();
  });

  test("uses the local TEI default when explicitly enabled", () => {
    expect(createRerankerFromEnv({ RERANK_PROVIDER: "tei" })).toMatchObject({
      provider: "tei",
      model: "BAAI/bge-reranker-v2-m3",
    });
  });

  test("accepts an explicit model and candidate-pool size", () => {
    const reranker = createRerankerFromEnv({
      RERANK_PROVIDER: "tei",
      RERANK_MODEL: "BAAI/bge-reranker-large",
    });

    expect(reranker?.model).toBe("BAAI/bge-reranker-large");
    expect(resolveRerankCandidateLimit("30")).toBe(30);
  });

  test.each(["", "zero", "0", "-1"])(
    "uses 20 rerank candidates for invalid value %s",
    (value) => {
      expect(resolveRerankCandidateLimit(value)).toBe(20);
    },
  );
});
