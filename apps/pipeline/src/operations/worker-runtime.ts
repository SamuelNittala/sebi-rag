import { createHash } from "node:crypto";

import {
  documentPublicationGenerations,
  eq,
  ingestionRuns,
  sourceRegistryRevisions,
  stageInspectionReview,
  type Database,
} from "@mf-rag/db";

import { createEmbedder, type Embedder } from "../../../ingestion/src/embedding/embedder.ts";
import { publishApprovedReviewRun } from "../../../ingestion/src/review/review-publisher.ts";
import { ChunkInspectStage } from "../../../ingestion/src/stages/chunk-inspect-stage.ts";
import { ParsePdfStage } from "../../../ingestion/src/stages/parse-pdf-stage.ts";
import type { ArtifactStore } from "../artifacts/artifact-store.ts";
import { WebsitePdfConnector } from "../connectors/website-pdf-connector.ts";
import {
  createDatabaseDiscoveryExecutionRepository,
  createDatabaseStageRuntimeRepository,
} from "../runtime/database-runtime-adapter.ts";
import { createRetryPolicy, type RetryPolicy } from "../runtime/retry-policy.ts";
import { DiscoveryWorker } from "../runtime/scheduler.ts";
import {
  deriveStageImplementationVersion,
  StageRegistry,
  type StageImplementationIdentityInput,
} from "../runtime/stage-registry.ts";
import { StageWorker } from "../runtime/stage-worker.ts";
import {
  ChunkInspectDocumentStage,
  createDatabaseChunkInspectDocumentRepository,
} from "../stages/chunk-inspect-document.ts";
import {
  createDatabaseDiscoverySourceRepository,
  DiscoverSourceStage,
} from "../stages/discover-source.ts";
import { FetchDocumentStage } from "../stages/fetch-document.ts";
import {
  createDatabaseParseDocumentRepository,
  ParseDocumentStage,
} from "../stages/parse-document.ts";
import {
  createDatabasePublishDocumentRepository,
  PublishDocumentStage,
  type ScheduledDocumentPublisher,
} from "../stages/publish-document.ts";
import {
  createDatabaseRouteReviewRepository,
  RouteReviewStage,
} from "../stages/route-review.ts";

type WorkerRole = "discovery-worker" | "stage-worker";

export interface ImmutableWorkerRuntimeConfig {
  readonly owner: string;
  readonly releaseDigest: string;
  readonly configChecksum: string;
  readonly parserVersion: string;
  readonly tableExtractorVersion: string;
  readonly parseArtifactProducerVersion: string;
  readonly fetchArtifactProducerVersion: string;
  readonly parseComponentVersion: string;
  readonly chunkComponentVersion: string;
  readonly reviewComponentVersion: string;
  readonly publishComponentVersion: string;
  readonly embeddingBaseUrl: string;
  readonly embeddingModel: string;
  readonly embeddingBatchSize: number;
  readonly claimBatchSize: number;
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly maxAttempts: number;
}

export interface WorkerRuntimeInput {
  readonly role: WorkerRole;
  readonly database: Database;
  readonly artifactStore: ArtifactStore;
}

export interface WorkerRuntime {
  readonly role: WorkerRole;
  runOnce(): Promise<number>;
  stop(gracePeriodMs: number): Promise<void>;
}

export interface WorkerCompositionOverrides {
  readonly retryPolicy?: RetryPolicy;
  readonly embedder?: Embedder;
  readonly publisher?: ScheduledDocumentPublisher;
  readonly verifyCurrentConfig?: (database: Database, expectedChecksum: string) => Promise<void>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function loadImmutableWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImmutableWorkerRuntimeConfig {
  const releaseDigest = required(env.PIPELINE_RELEASE_DIGEST, "PIPELINE_RELEASE_DIGEST");
  if (!RELEASE_DIGEST.test(releaseDigest)) {
    throw new Error("PIPELINE_RELEASE_DIGEST must be an immutable sha256:<64 lowercase hex> digest.");
  }
  const configChecksum = required(env.PIPELINE_CONFIG_CHECKSUM, "PIPELINE_CONFIG_CHECKSUM");
  if (!SHA256.test(configChecksum)) {
    throw new Error("PIPELINE_CONFIG_CHECKSUM must be the current lowercase SHA-256 configuration checksum.");
  }
  return {
    owner: required(env.PIPELINE_WORKER_ID, "PIPELINE_WORKER_ID"),
    releaseDigest,
    configChecksum,
    parserVersion: required(env.PIPELINE_PARSER_VERSION, "PIPELINE_PARSER_VERSION"),
    tableExtractorVersion: required(env.PIPELINE_TABLE_EXTRACTOR_VERSION, "PIPELINE_TABLE_EXTRACTOR_VERSION"),
    parseArtifactProducerVersion: required(env.PIPELINE_PARSE_ARTIFACT_VERSION, "PIPELINE_PARSE_ARTIFACT_VERSION"),
    fetchArtifactProducerVersion: required(env.PIPELINE_FETCH_ARTIFACT_VERSION, "PIPELINE_FETCH_ARTIFACT_VERSION"),
    parseComponentVersion: required(env.PIPELINE_PARSE_COMPONENT_VERSION, "PIPELINE_PARSE_COMPONENT_VERSION"),
    chunkComponentVersion: required(env.PIPELINE_CHUNK_COMPONENT_VERSION, "PIPELINE_CHUNK_COMPONENT_VERSION"),
    reviewComponentVersion: required(env.PIPELINE_REVIEW_COMPONENT_VERSION, "PIPELINE_REVIEW_COMPONENT_VERSION"),
    publishComponentVersion: required(env.PIPELINE_PUBLISH_COMPONENT_VERSION, "PIPELINE_PUBLISH_COMPONENT_VERSION"),
    embeddingBaseUrl: canonicalUrl(required(env.OLLAMA_BASE_URL, "OLLAMA_BASE_URL")),
    embeddingModel: required(env.EMBEDDING_MODEL, "EMBEDDING_MODEL"),
    embeddingBatchSize: integer(env.EMBEDDING_BATCH_SIZE, 10, "EMBEDDING_BATCH_SIZE"),
    claimBatchSize: integer(env.PIPELINE_CLAIM_BATCH_SIZE, 10, "PIPELINE_CLAIM_BATCH_SIZE"),
    leaseDurationMs: integer(env.PIPELINE_LEASE_DURATION_MS, 120_000, "PIPELINE_LEASE_DURATION_MS"),
    heartbeatIntervalMs: integer(env.PIPELINE_HEARTBEAT_INTERVAL_MS, 30_000, "PIPELINE_HEARTBEAT_INTERVAL_MS"),
    maxAttempts: integer(env.PIPELINE_MAX_ATTEMPTS, 3, "PIPELINE_MAX_ATTEMPTS"),
  };
}

export async function createWorkerRuntime(
  input: WorkerRuntimeInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: WorkerCompositionOverrides = {},
): Promise<WorkerRuntime> {
  const config = loadImmutableWorkerRuntimeConfig(env);
  if (config.heartbeatIntervalMs >= config.leaseDurationMs) {
    throw new Error("PIPELINE_HEARTBEAT_INTERVAL_MS must be shorter than PIPELINE_LEASE_DURATION_MS.");
  }
  await (overrides.verifyCurrentConfig ?? verifyCurrentConfigChecksum)(input.database, config.configChecksum);
  const retryPolicy = overrides.retryPolicy ?? createRetryPolicy();
  if (input.role === "discovery-worker") {
    return createDiscoveryRuntime(input, config, retryPolicy);
  }
  return createStageRuntime(input, config, retryPolicy, overrides);
}

async function verifyCurrentConfigChecksum(database: Database, expectedChecksum: string): Promise<void> {
  const [revision] = await database.select({ checksum: sourceRegistryRevisions.checksum })
    .from(sourceRegistryRevisions)
    .where(eq(sourceRegistryRevisions.isActive, true)).limit(1);
  if (!revision || revision.checksum !== expectedChecksum) {
    throw new Error("PIPELINE_CONFIG_CHECKSUM does not match the active reconciled source registry revision.");
  }
}

function createDiscoveryRuntime(
  input: WorkerRuntimeInput,
  config: ImmutableWorkerRuntimeConfig,
  retryPolicy: RetryPolicy,
): WorkerRuntime {
  const repository = createDatabaseDiscoverySourceRepository(input.database);
  const parseIdentity = identity(config, config.parseComponentVersion);
  const fetch = new FetchDocumentStage({
    repository,
    artifactStore: input.artifactStore,
    pipelineIdentity: {
      pipelineImplementationVersion: pipelineImplementationVersion(config),
      parseImplementationVersion: deriveStageImplementationVersion(parseIdentity),
      maxAttempts: config.maxAttempts,
    },
    artifactProducerVersion: config.fetchArtifactProducerVersion,
  });
  const discover = new DiscoverSourceStage({
    repository,
    connectorFactory: (constraints) => new WebsitePdfConnector(constraints),
    fetchStage: fetch,
  });
  const worker = new DiscoveryWorker({
    owner: config.owner,
    repository: createDatabaseDiscoveryExecutionRepository(input.database),
    handler: async (work) => { await discover.execute(work); },
    retryPolicy,
    claimBatchSize: config.claimBatchSize,
    leaseDurationMs: config.leaseDurationMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });
  return {
    role: input.role,
    runOnce: () => worker.runOnce(),
    stop: (gracePeriodMs) => worker.stop(gracePeriodMs),
  };
}

function createStageRuntime(
  input: WorkerRuntimeInput,
  config: ImmutableWorkerRuntimeConfig,
  retryPolicy: RetryPolicy,
  overrides: WorkerCompositionOverrides,
): WorkerRuntime {
  const parseAdapter = new ParsePdfStage({ artifactStore: input.artifactStore }, {
    parserVersion: config.parserVersion,
    tableExtractorVersion: config.tableExtractorVersion,
    producerVersion: config.parseArtifactProducerVersion,
  });
  const parse = new ParseDocumentStage({
    repository: createDatabaseParseDocumentRepository(input.database),
    adapter: parseAdapter,
  });
  const chunkAdapter = new ChunkInspectStage({
    artifactStore: input.artifactStore,
    reviewRepository: { stage: (review) => stageInspectionReview(input.database, review) },
  });
  const chunk = new ChunkInspectDocumentStage({
    repository: createDatabaseChunkInspectDocumentRepository(input.database),
    adapter: chunkAdapter,
  });
  const review = new RouteReviewStage({
    repository: createDatabaseRouteReviewRepository(input.database),
    actor: "system:risk-policy",
  });
  const publisher = overrides.publisher ?? createScheduledPublisher(
    input.database,
    overrides.embedder ?? createEmbedder({
      baseUrl: config.embeddingBaseUrl,
      model: config.embeddingModel,
      batchSize: config.embeddingBatchSize,
    }),
  );
  const publish = new PublishDocumentStage({
    repository: createDatabasePublishDocumentRepository(input.database),
    publisher,
  });
  const registry = new StageRegistry([
    { stage: "PARSE", implementationIdentity: identity(config, config.parseComponentVersion), handler: (context) => parse.execute(context) },
    { stage: "CHUNK_AND_INSPECT", implementationIdentity: identity(config, config.chunkComponentVersion), handler: (context) => chunk.execute(context) },
    { stage: "REVIEW_DECISION", implementationIdentity: identity(config, config.reviewComponentVersion), handler: (context) => review.execute(context) },
    { stage: "EMBED_AND_PUBLISH", implementationIdentity: identity(config, config.publishComponentVersion), handler: (context) => publish.execute(context) },
  ]);
  const worker = new StageWorker({
    owner: config.owner,
    repository: createDatabaseStageRuntimeRepository(input.database),
    registry,
    retryPolicy,
    claimBatchSize: config.claimBatchSize,
    leaseDurationMs: config.leaseDurationMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  });
  return {
    role: input.role,
    runOnce: () => worker.runOnce(),
    stop: (gracePeriodMs) => worker.stop({ gracePeriodMs }),
  };
}

function createScheduledPublisher(database: Database, embedder: Embedder): ScheduledDocumentPublisher {
  return {
    async publish({ reviewRunId, signal }) {
      signal.throwIfAborted();
      const [run] = await database.select().from(ingestionRuns)
        .where(eq(ingestionRuns.id, reviewRunId)).limit(1);
      if (!run?.documentVersionId || !run.pipelineRunId || !run.configRevisionId) {
        throw deterministic("SCHEDULED_REVIEW_LINEAGE_MISSING", "Publication requires an exact scheduled review lineage.");
      }
      if (run.visibilityScope !== "TENANT" || !run.tenantId) {
        throw deterministic("SCHEDULED_REVIEW_TENANT_MISSING", "Scheduled tenant publication requires exact reviewed tenant ownership.");
      }
      await publishApprovedReviewRun(run.id, {
        database,
        embedder,
        actor: "system:pipeline-publisher",
        authorizedTenantId: run.tenantId,
        signal,
      });
      const [generation] = await database.select().from(documentPublicationGenerations)
        .where(eq(documentPublicationGenerations.ingestionRunId, run.id)).limit(1);
      if (!generation || generation.status !== "published") {
        throw new Error("Scheduled publisher did not commit a published generation.");
      }
      return {
        generationId: generation.id,
        outputChecksum: createHash("sha256").update(JSON.stringify({
          generationId: generation.id,
          reviewRunId: run.id,
          documentVersionId: run.documentVersionId,
          tenantId: run.tenantId,
        })).digest("hex"),
      };
    },
  };
}

function identity(
  config: ImmutableWorkerRuntimeConfig,
  componentVersion: string,
): StageImplementationIdentityInput {
  return {
    releaseIdentity: config.releaseDigest,
    componentVersion,
    configChecksum: config.configChecksum,
  };
}

function pipelineImplementationVersion(config: ImmutableWorkerRuntimeConfig): string {
  return `pipeline-v1:${createHash("sha256").update(JSON.stringify([
    config.releaseDigest,
    config.configChecksum,
  ])).digest("hex")}`;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required when pipeline claims are enabled.`);
  const canonical = value.trim();
  if (canonical.length > 255 || /[\u0000-\u001f\u007f]/.test(canonical)) {
    throw new Error(`${name} must be a canonical value of at most 255 characters.`);
  }
  return canonical;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("OLLAMA_BASE_URL must be an HTTP(S) URL without inline credentials.");
  }
  return url.href.replace(/\/$/, "");
}

function deterministic(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
