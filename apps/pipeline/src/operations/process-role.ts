import { client, db, type Database } from "@mf-rag/db";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import type { ArtifactStore } from "../artifacts/artifact-store.ts";
import { createDatabaseDiscoverySchedulerStore } from "../runtime/database-runtime-adapter.ts";
import { DiscoveryScheduler } from "../runtime/scheduler.ts";
import { artifactStoreFromEnvironment, requiredEnvironmentValue } from "./artifact-store-config.ts";
import { PipelineHealth, startHealthServer, type ReadinessProbe } from "./health.ts";
import { PipelineMetrics, structuredPipelineLog } from "./metrics.ts";
import { refreshPipelineMetrics } from "./metrics-collector.ts";

type PipelineProcessRole = "scheduler" | "discovery-worker" | "stage-worker";

export interface OperationalWorkerRuntime {
  runOnce(): Promise<number>;
  stop(gracePeriodMs: number): Promise<void>;
}

export interface OperationalWorkerModule {
  createWorkerRuntime(input: {
    readonly role: Exclude<PipelineProcessRole, "scheduler">;
    readonly database: Database;
    readonly artifactStore: ArtifactStore;
  }): Promise<OperationalWorkerRuntime> | OperationalWorkerRuntime;
}

export async function runPipelineProcess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const role = processRole(env.PIPELINE_ROLE);
  const claimsEnabled = env.PIPELINE_CLAIMS_ENABLED === "true";
  const artifact = role === "scheduler" ? null : artifactStoreFromEnvironment(env);
  const probes: ReadinessProbe[] = [{ name: "postgres", check: async () => { await client`select 1`; } }];
  if (artifact) probes.push({ name: "artifact_store", check: () => artifact.store.healthCheck() });
  const health = new PipelineHealth(role, probes, positiveInteger(env.PIPELINE_STUCK_AFTER_MS, 60_000));
  const metrics = new PipelineMetrics();
  const server = startHealthServer({
    health,
    metrics,
    port: positiveInteger(env.PIPELINE_HEALTH_PORT, role === "scheduler" ? 3010 : 3011),
  });
  const correlationId = crypto.randomUUID();
  const runtime = claimsEnabled
    ? await createRuntime(role, env, artifact?.store ?? null)
    : null;
  console.log(structuredPipelineLog("info", "process.started", { correlationId }, { role, claims_enabled: claimsEnabled }));
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(structuredPipelineLog("info", "process.draining", { correlationId }, { role, signal }));
    if (runtime?.kind === "worker") {
      await runtime.worker.stop(positiveInteger(env.PIPELINE_SHUTDOWN_GRACE_MS, 30_000));
    }
    health.markClaimLoopStopped();
    server.stop(true);
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });

  try {
    while (!stopping) {
      if (runtime?.kind === "scheduler") await runtime.scheduler.tick();
      if (runtime?.kind === "worker") await runtime.worker.runOnce();
      await refreshPipelineMetrics(db, metrics);
      health.markLoopProgress();
      await Bun.sleep(positiveInteger(env.PIPELINE_POLL_INTERVAL_MS, 5_000));
    }
  } finally {
    await shutdown("loop_exit");
  }
}

async function createRuntime(
  role: PipelineProcessRole,
  env: Readonly<Record<string, string | undefined>>,
  artifactStore: ArtifactStore | null,
): Promise<
  | { readonly kind: "scheduler"; readonly scheduler: DiscoveryScheduler }
  | { readonly kind: "worker"; readonly worker: OperationalWorkerRuntime }
> {
  if (role === "scheduler") {
    return {
      kind: "scheduler",
      scheduler: new DiscoveryScheduler({
        store: createDatabaseDiscoverySchedulerStore(db),
        maxClaimsPerTick: positiveInteger(env.PIPELINE_CLAIM_BATCH_SIZE, 10),
      }),
    };
  }
  if (!artifactStore) throw new Error("Worker artifact store was not initialized.");
  const moduleUrl = validateWorkerModuleUrl(
    requiredEnvironmentValue(env.PIPELINE_WORKER_MODULE, "PIPELINE_WORKER_MODULE"),
  );
  const module = await import(moduleUrl) as Partial<OperationalWorkerModule>;
  if (typeof module.createWorkerRuntime !== "function") {
    throw new Error("PIPELINE_WORKER_MODULE must export createWorkerRuntime.");
  }
  const worker = await module.createWorkerRuntime({ role, database: db, artifactStore });
  if (!worker || typeof worker.runOnce !== "function" || typeof worker.stop !== "function") {
    throw new Error("Pipeline worker module returned an invalid runtime.");
  }
  return { kind: "worker", worker };
}

export function validateWorkerModuleUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("PIPELINE_WORKER_MODULE must be a valid immutable-image file URL.");
  }
  if (url.protocol !== "file:" || url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("PIPELINE_WORKER_MODULE must be a local file URL without authority, query, or fragment.");
  }
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch {
    throw new Error("PIPELINE_WORKER_MODULE contains invalid path encoding.");
  }
  const normalized = posix.normalize(decoded);
  if (decoded !== normalized || !normalized.startsWith("/app/apps/") || !/\.[cm]?[jt]s$/.test(normalized)) {
    throw new Error("PIPELINE_WORKER_MODULE must resolve to a source module below /app/apps/ without traversal.");
  }
  return pathToFileURL(normalized).href;
}

function processRole(value: string | undefined): PipelineProcessRole {
  if (value === "scheduler" || value === "discovery-worker" || value === "stage-worker") return value;
  throw new Error("PIPELINE_ROLE must be scheduler, discovery-worker, or stage-worker.");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Pipeline integer configuration must be positive.");
  return number;
}

if (import.meta.main) await runPipelineProcess();
