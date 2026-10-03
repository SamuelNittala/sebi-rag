#!/usr/bin/env bun
/**
 * Seeds one Docling review run with full pipeline lineage into a development
 * or scratch database, for checking the review page view in a browser.
 *
 *   DATABASE_URL=postgres://... bun run scripts/seed-review-page-view.ts \
 *     --artifact-root ./data/artifacts \
 *     (--pdf ~/Downloads/factsheet.pdf --docling-url http://127.0.0.1:8098 | --golden mirae-flexi-cap-p34-35) \
 *     [--document-type Factsheet] [--canonical-url https://example.com/factsheet.pdf]
 *
 * Runs the real stage code: the raw PDF goes into a `FilesystemArtifactStore`
 * under `--artifact-root`, `DoclingParseStage` parses it (HTTP against a running
 * docling service, or the committed golden wire response for `--golden`), and
 * `ChunkInspectDocumentStage` with `ChunkInspectStage` maps, inspects and stages
 * the review run from the stored parse artifact, exactly as the stage worker.
 * The script inserts its own registry revision, access scope, source, source
 * document, document version, pipeline run and PARSE attempt (it never
 * reconciles or changes existing registry rows). Start the API with
 * `ARTIFACT_STORE=filesystem ARTIFACT_FILESYSTEM_ROOT=<same root>`.
 *
 * Refuses NODE_ENV=production. Prints the review run id and page view path.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type DesiredSourceRegistry,
  type SourceDocumentType,
} from "@mf-rag/types";
import { db, type Database } from "@mf-rag/db";
import * as schema from "../packages/db/src/schema.ts";
import { stageInspectionReview } from "../packages/db/src/review-queries.ts";
import { fetchDoclingHealth } from "../apps/ingestion/src/parsers/docling-client.ts";
import type { DoclingParseResponse } from "../apps/ingestion/src/parsers/docling-contract.ts";
import { ChunkInspectStage } from "../apps/ingestion/src/stages/chunk-inspect-stage.ts";
import { DoclingParseStage } from "../apps/ingestion/src/stages/docling-parse-stage.ts";
import { sha256Hex } from "../apps/pipeline/src/artifacts/artifact-store.ts";
import { FilesystemArtifactStore } from "../apps/pipeline/src/artifacts/filesystem-artifact-store.ts";
import {
  ChunkInspectDocumentStage,
  createDatabaseChunkInspectDocumentRepository,
} from "../apps/pipeline/src/stages/chunk-inspect-document.ts";
import { encodeArtifactOutputRef } from "../apps/pipeline/src/stages/parse-document.ts";

const GOLDEN_DIR = resolve(import.meta.dir, "../tests/fixtures/docling");
const PARSE_ARTIFACT_VERSION = "parse-artifact-v1";

interface Args {
  readonly artifactRoot: string;
  readonly pdf: string;
  readonly golden: string | null;
  readonly doclingUrl: string | null;
  readonly documentType: SourceDocumentType | null;
  readonly canonicalUrl: string;
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      "artifact-root": { type: "string" },
      pdf: { type: "string" },
      golden: { type: "string" },
      "docling-url": { type: "string" },
      "document-type": { type: "string", default: "Factsheet" },
      "canonical-url": { type: "string" },
    },
    strict: true,
  });
  const artifactRoot = values["artifact-root"];
  if (!artifactRoot) throw new Error("--artifact-root is required.");
  if (Boolean(values.pdf) === Boolean(values.golden)) throw new Error("Pass exactly one of --pdf or --golden.");
  if (values.pdf && !values["docling-url"]) throw new Error("--pdf needs --docling-url.");
  if (values.golden && !/^[a-z0-9-]+$/.test(values.golden)) throw new Error("--golden must be a fixture name.");
  const pdf = values.pdf ? resolve(values.pdf) : resolve(GOLDEN_DIR, `${values.golden}.pdf`);
  const documentType = values["document-type"] === "none" ? null : values["document-type"] as SourceDocumentType;
  return {
    artifactRoot: resolve(artifactRoot),
    pdf,
    golden: values.golden ?? null,
    doclingUrl: values["docling-url"] ?? null,
    documentType,
    canonicalUrl: values["canonical-url"] ?? `https://example.com/review-page-view/${encodeURIComponent(basename(pdf))}`,
  };
}

async function seedRegistry(database: Database, args: Args) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const externalCode = `9${Date.now()}`.slice(0, 15);
  const accessScopeKey = createAccessScopeKey(`page-view-${suffix}`);
  const sourceKey = createSourceKey(`page-view-${suffix}`);
  const host = new URL(args.canonicalUrl).hostname;
  const desiredSource = {
    sourceKey,
    connector: "website_pdf" as const,
    enabled: false,
    discovery: { strategy: "explicit_urls" as const, urls: [] },
    schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
    fetch: { allowedHosts: [host], allowedPathPrefixes: ["/"], maxBytes: 100_000_000, timeoutMs: 60_000, maxRedirects: 1 },
    review: { policy: "risk_based" as const },
    ...(args.documentType ? { documentType: args.documentType } : {}),
  };
  const desiredState: DesiredSourceRegistry = {
    version: 1,
    accessScopes: [{
      apiVersion: "mf-rag/v1",
      accessScopeKey,
      externalCode: createExternalAccessCode(externalCode),
      classification: { knowledgeDomain: "mutual_fund", sourceCollection: "mirae_mf", amcSlug: "mirae-asset" },
      sources: [desiredSource],
    }],
  };
  const [revision] = await database.insert(schema.sourceRegistryRevisions).values({
    checksum: createHash("sha256").update(`page-view-${suffix}`).digest("hex"),
    desiredState,
  }).returning();
  const [scope] = await database.insert(schema.accessScopes).values({
    accessScopeKey,
    externalCode,
    tenantId: externalCode,
    knowledgeDomain: "mutual_fund",
    sourceCollection: "mirae_mf",
    amcSlug: "mirae-asset",
    enabled: false,
    configRevisionId: revision!.id,
  }).returning();
  const [source] = await database.insert(schema.sources).values({
    accessScopeId: scope!.id,
    sourceKey,
    connector: "website_pdf",
    discoveryConfig: desiredSource.discovery,
    fetchConfig: desiredSource.fetch,
    reviewConfig: desiredSource.review,
    enabled: false,
    configRevisionId: revision!.id,
  }).returning();
  const [document] = await database.insert(schema.sourceDocuments).values({
    accessScopeId: scope!.id,
    sourceId: source!.id,
    logicalDocumentKey: createLogicalDocumentKey(`page-view-${suffix}`),
    canonicalUrl: args.canonicalUrl,
  }).returning();
  return { revisionId: revision!.id, accessScopeId: scope!.id, sourceId: source!.id, sourceDocumentId: document!.id };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed review page view data in production.");
  const args = parseCliArgs();
  const store = new FilesystemArtifactStore(args.artifactRoot);
  const registry = await seedRegistry(db, args);

  const pdfBytes = new Uint8Array(await Bun.file(args.pdf).arrayBuffer());
  const documentVersionId = crypto.randomUUID();
  const rawArtifact = await store.put({
    namespace: `raw/${documentVersionId}`,
    bytes: pdfBytes,
    sha256: sha256Hex(pdfBytes),
    byteSize: pdfBytes.byteLength,
    mediaType: "application/pdf",
    producerVersion: "seed-review-page-view",
  });
  const [artifactRow] = await db.insert(schema.artifacts).values({
    artifactKey: rawArtifact.key,
    uri: rawArtifact.uri,
    sha256: rawArtifact.sha256,
    byteSize: rawArtifact.byteSize,
    mediaType: rawArtifact.mediaType,
    producerVersion: rawArtifact.producerVersion,
    verifiedAt: new Date(),
  }).returning();
  await db.insert(schema.documentVersions).values({
    id: documentVersionId,
    sourceDocumentId: registry.sourceDocumentId,
    accessScopeId: registry.accessScopeId,
    sourceId: registry.sourceId,
    sequence: 1,
    contentSha256: rawArtifact.sha256,
    rawArtifactId: artifactRow!.id,
    configRevisionId: registry.revisionId,
    readyAt: new Date(),
  });
  const [pipelineRun] = await db.insert(schema.pipelineRuns).values({
    documentVersionId,
    accessScopeId: registry.accessScopeId,
    sourceId: registry.sourceId,
    implementationVersion: `seed-review-page-view-${documentVersionId}`,
    configRevisionId: registry.revisionId,
    initialStage: "PARSE",
    initialStageImplementationVersion: "seed-review-page-view",
    initialInputChecksum: rawArtifact.sha256,
    initialMaxAttempts: 1,
  }).returning();

  const golden: DoclingParseResponse | null = args.golden
    ? await Bun.file(resolve(GOLDEN_DIR, `${args.golden}.wire.json`)).json()
    : null;
  const parserVersion = golden?.producer.parserVersion ?? (await fetchDoclingHealth(args.doclingUrl!)).parserVersion;
  const parseStage = new DoclingParseStage({
    artifactStore: store,
    ...(golden ? { parse: async () => golden } : {}),
  }, {
    serviceUrl: args.doclingUrl ?? "http://docling:8090",
    parserVersion,
    producerVersion: `${PARSE_ARTIFACT_VERSION}+${parserVersion}`,
    deadlineMs: 3_600_000,
    maxPages: 500,
    maxTextChars: 10_000_000,
    maxResponseBytes: 200_000_000,
  });
  console.error(`Parsing ${basename(args.pdf)} with ${parserVersion}${golden ? " (golden wire)" : ` at ${args.doclingUrl}`}...`);
  const started = performance.now();
  const parse = await parseStage.execute({
    documentVersionId,
    rawArtifact,
    filename: basename(args.pdf),
    canonicalUrl: args.canonicalUrl,
  });
  console.error(`  parsed ${parse.parsed.diagnostics.pageCount} pages, ${parse.parsed.chunks.length} chunks in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  await db.insert(schema.stageAttempts).values({
    pipelineRunId: pipelineRun!.id,
    documentVersionId,
    accessScopeId: registry.accessScopeId,
    sourceId: registry.sourceId,
    stage: "PARSE",
    implementationVersion: parse.artifact.producerVersion,
    inputChecksum: rawArtifact.sha256,
    outputRef: encodeArtifactOutputRef(parse.artifact),
    outputChecksum: parse.artifact.sha256,
    status: "succeeded",
    startedAt: new Date(),
    completedAt: new Date(),
  });

  const chunkStage = new ChunkInspectDocumentStage({
    repository: createDatabaseChunkInspectDocumentRepository(db),
    adapter: new ChunkInspectStage({
      artifactStore: store,
      reviewRepository: { stage: (review) => stageInspectionReview(db, review) },
    }),
  });
  const result = await chunkStage.execute({
    pipelineRunId: pipelineRun!.id,
    documentVersionId,
    accessScopeId: registry.accessScopeId,
    sourceId: registry.sourceId,
    inputChecksum: parse.artifact.sha256,
    signal: new AbortController().signal,
  });
  const reviewRunId = result.outputRef.replace(/^review:/, "");
  console.log(JSON.stringify({
    reviewRunId,
    pipelineRunId: pipelineRun!.id,
    documentVersionId,
    pageCount: parse.parsed.diagnostics.pageCount,
    pageView: `/review/documents/${reviewRunId}/pages`,
  }));
}

try {
  await main();
} finally {
  const { client } = await import("@mf-rag/db");
  await client.close();
}
