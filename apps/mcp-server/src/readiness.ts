import type { Embedder } from "@mf-rag/core";
import type { VectorClient } from "@mf-rag/vector";
import type { Reranker } from "./reranker.ts";

export interface ReadinessDependencies {
  readonly embedder: Pick<Embedder, "checkHealth">;
  readonly vectorClient: Pick<VectorClient, "collectionExists">;
  readonly reranker: Pick<Reranker, "checkHealth"> | null;
  readonly timeoutMs?: number;
}

export interface ReadinessStatus {
  readonly status: "ok" | "error";
  readonly services: {
    readonly embedding: boolean;
    readonly pgvector: boolean;
    readonly reranker?: boolean;
  };
}

async function vectorReady(vectorClient: Pick<VectorClient, "collectionExists">): Promise<boolean> {
  try {
    await vectorClient.collectionExists();
    return true;
  } catch {
    return false;
  }
}

async function withinTimeout(check: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    check,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function checkReadiness(
  dependencies: ReadinessDependencies,
): Promise<ReadinessStatus> {
  const timeoutMs = dependencies.timeoutMs ?? 5_000;
  const [embedding, pgvector, reranker] = await Promise.all([
    withinTimeout(dependencies.embedder.checkHealth(), timeoutMs),
    withinTimeout(vectorReady(dependencies.vectorClient), timeoutMs),
    dependencies.reranker
      ? withinTimeout(dependencies.reranker.checkHealth(), timeoutMs)
      : undefined,
  ]);
  const services = {
    embedding,
    pgvector,
    ...(dependencies.reranker && { reranker: reranker ?? false }),
  };
  return {
    status: Object.values(services).every(Boolean) ? "ok" : "error",
    services,
  };
}
