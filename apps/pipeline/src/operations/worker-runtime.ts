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
import { fetchDoclingHealth } from "../../../ingestion/src/parsers/docling-client.ts";
import { ChunkInspectStage } from "../../../ingestion/src/stages/chunk-inspect-stage.ts";
import { DoclingParseStage } from "../../../ingestion/src/stages/docling-parse-stage.ts";
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
  createParserRoutingAdapter,
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
  readonly releaseIdentity: string;
  readonly configChecksum: string;
  readonly parserVersion: string;
  readonly tableExtractorVersion: string;
  readonly fetchArtifactVersion: string;
  readonly parseArtifactVersion: string;
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
  readonly parseDeadlineMs: number;
  readonly parseMaxPages: number;
  readonly parseMaxTextChars: number;
  readonly tableOutputMaxBytes: number;
  /** Null when Docling is not deployed; sources selecting it then fail with DOCLING_PARSER_NOT_CONFIGURED. */
  readonly doclingServiceUrl: string | null;
  /** Required iff doclingServiceUrl is set; must equal the service's /health parserVersion. */
  readonly doclingParserVersion: string | null;
  readonly doclingParseDeadlineMs: number;
  readonly doclingMaxResponseBytes: number;
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
  readonly verifyEmbeddingModel?: (baseUrl: string, model: string) => Promise<void>;
  readonly verifyDoclingParser?: (baseUrl: string, parserVersion: string) => Promise<void>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_IDENTITY = /^sha256:[0-9a-f]{64}$/;

export function loadImmutableWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImmutableWorkerRuntimeConfig {
  const configChecksum = required(env.PIPELINE_CONFIG_CHECKSUM, "PIPELINE_CONFIG_CHECKSUM");
  if (!SHA256.test(configChecksum)) {
    throw new Error("PIPELINE_CONFIG_CHECKSUM must be the current lowercase SHA-256 configuration checksum.");
  }
  const releaseIdentity = required(env.PIPELINE_RELEASE_DIGEST, "PIPELINE_RELEASE_DIGEST");
  if (!RELEASE_IDENTITY.test(releaseIdentity)) {
    throw new Error("PIPELINE_RELEASE_DIGEST must use sha256:<64 lowercase hex>.");
  }
  const doclingServiceUrl = env.PIPELINE_DOCLING_SERVICE_URL?.trim()
    ? canonicalUrl(env.PIPELINE_DOCLING_SERVICE_URL.trim(), "PIPELINE_DOCLING_SERVICE_URL")
    : null;
  const doclingParserVersion = env.PIPELINE_DOCLING_PARSER_VERSION?.trim()
    ? required(env.PIPELINE_DOCLING_PARSER_VERSION, "PIPELINE_DOCLING_PARSER_VERSION")
    : null;
  if (doclingServiceUrl && !doclingParserVersion) {
    throw new Error("PIPELINE_DOCLING_PARSER_VERSION is required when PIPELINE_DOCLING_SERVICE_URL is set.");
  }
  if (doclingParserVersion && !doclingServiceUrl) {
    throw new Error("PIPELINE_DOCLING_SERVICE_URL is required when PIPELINE_DOCLING_PARSER_VERSION is set.");
  }
  return {
    owner: required(env.PIPELINE_WORKER_ID, "PIPELINE_WORKER_ID"),
    releaseIdentity,
    configChecksum,
    parserVersion: required(env.PIPELINE_PARSER_VERSION, "PIPELINE_PARSER_VERSION"),
    tableExtractorVersion: required(env.PIPELINE_TABLE_EXTRACTOR_VERSION, "PIPELINE_TABLE_EXTRACTOR_VERSION"),
    fetchArtifactVersion: required(env.PIPELINE_FETCH_ARTIFACT_VERSION, "PIPELINE_FETCH_ARTIFACT_VERSION"),
    parseArtifactVersion: required(env.PIPELINE_PARSE_ARTIFACT_VERSION, "PIPELINE_PARSE_ARTIFACT_VERSION"),
    parseComponentVersion: required(env.PIPELINE_PARSE_COMPONENT_VERSION, "PIPELINE_PARSE_COMPONENT_VERSION"),
    chunkComponentVersion: required(env.PIPELINE_CHUNK_COMPONENT_VERSION, "PIPELINE_CHUNK_COMPONENT_VERSION"),
    reviewComponentVersion: required(env.PIPELINE_REVIEW_COMPONENT_VERSION, "PIPELINE_REVIEW_COMPONENT_VERSION"),
    publishComponentVersion: required(env.PIPELINE_PUBLISH_COMPONENT_VERSION, "PIPELINE_PUBLISH_COMPONENT_VERSION"),
    embeddingBaseUrl: canonicalUrl(required(env.OLLAMA_BASE_URL, "OLLAMA_BASE_URL"), "OLLAMA_BASE_URL"),
    embeddingModel: required(env.EMBEDDING_MODEL, "EMBEDDING_MODEL"),
    embeddingBatchSize: integer(env.EMBEDDING_BATCH_SIZE, 10, "EMBEDDING_BATCH_SIZE"),
    claimBatchSize: integer(env.PIPELINE_CLAIM_BATCH_SIZE, 10, "PIPELINE_CLAIM_BATCH_SIZE"),
    leaseDurationMs: integer(env.PIPELINE_LEASE_DURATION_MS, 120_000, "PIPELINE_LEASE_DURATION_MS"),
    heartbeatIntervalMs: integer(env.PIPELINE_HEARTBEAT_INTERVAL_MS, 30_000, "PIPELINE_HEARTBEAT_INTERVAL_MS"),
    maxAttempts: integer(env.PIPELINE_MAX_ATTEMPTS, 3, "PIPELINE_MAX_ATTEMPTS"),
    parseDeadlineMs: integer(env.PIPELINE_PARSE_DEADLINE_MS, 120_000, "PIPELINE_PARSE_DEADLINE_MS"),
    parseMaxPages: integer(env.PIPELINE_PARSE_MAX_PAGES, 500, "PIPELINE_PARSE_MAX_PAGES"),
    parseMaxTextChars: integer(env.PIPELINE_PARSE_MAX_TEXT_CHARS, 10_000_000, "PIPELINE_PARSE_MAX_TEXT_CHARS"),
    tableOutputMaxBytes: integer(env.PIPELINE_TABLE_OUTPUT_MAX_BYTES, 10_000_000, "PIPELINE_TABLE_OUTPUT_MAX_BYTES"),
    doclingServiceUrl,
    doclingParserVersion,
    doclingParseDeadlineMs: integer(env.PIPELINE_DOCLING_PARSE_DEADLINE_MS, 1_800_000, "PIPELINE_DOCLING_PARSE_DEADLINE_MS"),
    doclingMaxResponseBytes: integer(env.PIPELINE_DOCLING_MAX_RESPONSE_BYTES, 50_000_000, "PIPELINE_DOCLING_MAX_RESPONSE_BYTES"),
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
  await (overrides.verifyEmbeddingModel ?? verifyEmbeddingModelAvailable)(
    config.embeddingBaseUrl,
    config.embeddingModel,
  );
  if (config.doclingServiceUrl && config.doclingParserVersion) {
    await (overrides.verifyDoclingParser ?? verifyDoclingParserVersion)(
      config.doclingServiceUrl,
      config.doclingParserVersion,
    );
  }
  return createStageRuntime(input, config, retryPolicy, overrides);
}

export async function verifyDoclingParserVersion(baseUrl: string, parserVersion: string): Promise<void> {
  const health = await fetchDoclingHealth(baseUrl, AbortSignal.timeout(10_000));
  if (health.parserVersion !== parserVersion) {
    throw new Error("Docling service parserVersion does not match PIPELINE_DOCLING_PARSER_VERSION.");
  }
}

export async function verifyEmbeddingModelAvailable(baseUrl: string, model: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Embedding service readiness failed with HTTP ${response.status}.`);
  const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  const acceptedNames = new Set([model, ...(model.includes(":") ? [] : [`${model}:latest`])]);
  if (!body.models?.some((entry) => acceptedNames.has(entry.name ?? "") || acceptedNames.has(entry.model ?? ""))) {
    throw new Error(`Configured embedding model '${model}' is not installed.`);
  }
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
  const fetch = new FetchDocumentStage({
    repository,
    artifactStore: input.artifactStore,
    pipelineIdentity: {
      pipelineImplementationVersion: pipelineImplementationVersion(config),
      parseImplementationVersion: deriveStageImplementationVersion(parseIdentity(config)),
      maxAttempts: config.maxAttempts,
    },
    artifactProducerVersion: config.fetchArtifactVersion,
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
    producerVersion: config.parseArtifactVersion,
    deadlineMs: config.parseDeadlineMs,
    maxPages: config.parseMaxPages,
    maxTextChars: config.parseMaxTextChars,
    maxTableOutputBytes: config.tableOutputMaxBytes,
  });
  const doclingAdapter = config.doclingServiceUrl && config.doclingParserVersion
    ? new DoclingParseStage({ artifactStore: input.artifactStore }, {
      serviceUrl: config.doclingServiceUrl,
      parserVersion: config.doclingParserVersion,
      producerVersion: `${config.parseArtifactVersion}+${config.doclingParserVersion}`,
      deadlineMs: config.doclingParseDeadlineMs,
      maxPages: config.parseMaxPages,
      maxTextChars: config.parseMaxTextChars,
      maxResponseBytes: config.doclingMaxResponseBytes,
    })
    : null;
  const parse = new ParseDocumentStage({
    repository: createDatabaseParseDocumentRepository(input.database),
    adapter: createParserRoutingAdapter({ unpdf: parseAdapter, docling: doclingAdapter }),
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
    { stage: "PARSE", implementationIdentity: parseIdentity(config), handler: (context) => parse.execute(context) },
    { stage: "CHUNK_AND_INSPECT", implementationIdentity: stageIdentity(config, config.chunkComponentVersion), handler: (context) => chunk.execute(context) },
    { stage: "REVIEW_DECISION", implementationIdentity: stageIdentity(config, config.reviewComponentVersion), handler: (context) => review.execute(context) },
    { stage: "EMBED_AND_PUBLISH", implementationIdentity: stageIdentity(config, config.publishComponentVersion, config.embeddingModel), handler: (context) => publish.execute(context) },
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

function pipelineImplementationVersion(config: ImmutableWorkerRuntimeConfig): string {
  return `pipeline-v2:${createHash("sha256").update(JSON.stringify([
    config.releaseIdentity,
    config.fetchArtifactVersion,
    config.configChecksum,
  ])).digest("hex")}`;
}

export function parseIdentity(config: ImmutableWorkerRuntimeConfig): StageImplementationIdentityInput {
  return stageIdentity(
    config,
    config.parseComponentVersion,
    config.parserVersion,
    config.tableExtractorVersion,
    config.parseArtifactVersion,
    // Appended only when configured so unpdf-only deployments keep their identity.
    ...(config.doclingParserVersion ? [config.doclingParserVersion] : []),
  );
}

function stageIdentity(
  config: ImmutableWorkerRuntimeConfig,
  ...componentParts: readonly string[]
): StageImplementationIdentityInput {
  const componentVersion = `component-v1:${createHash("sha256")
    .update(JSON.stringify(componentParts))
    .digest("hex")}`;
  return {
    releaseIdentity: config.releaseIdentity,
    componentVersion,
    configChecksum: config.configChecksum,
  };
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

function canonicalUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP(S) URL without inline credentials.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${name} must be an HTTP(S) URL without inline credentials.`);
  }
  return url.href.replace(/\/$/, "");
}

function deterministic(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, classification: "deterministic" as const });
}
