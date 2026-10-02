import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";
import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type DesiredSourceRegistry,
  type SourceDocumentType,
} from "@mf-rag/types";
import type { Database } from "@mf-rag/db";

import * as schema from "../../../../packages/db/src/schema.ts";
import { reconcileSourceRegistry } from "../../../../packages/db/src/source-registry-queries.ts";
import { createDatabaseChunkInspectDocumentRepository } from "./chunk-inspect-document.ts";
import { encodeArtifactOutputRef } from "./parse-document.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("CHUNK_AND_INSPECT input source document type", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });

  async function resetDatabase() {
    await client.unsafe(`TRUNCATE
      stage_attempts, pipeline_runs, document_versions, source_documents, artifacts, discovery_runs,
      source_schedules, sources, access_scopes, source_registry_revisions
      CASCADE`);
  }

  async function seedParsedVersion(documentType?: SourceDocumentType) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const sourceKey = createSourceKey(`factsheets-${suffix}`);
    const registry: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        apiVersion: "mf-rag/v1",
        accessScopeKey: createAccessScopeKey(`chunk-${suffix}`),
        externalCode: createExternalAccessCode(`8${Date.now()}`.slice(0, 15)),
        classification: { knowledgeDomain: "mutual_fund", sourceCollection: "mirae_mf", amcSlug: "mirae-asset" },
        sources: [{
          sourceKey,
          connector: "website_pdf",
          enabled: false,
          discovery: { strategy: "explicit_urls", urls: [] },
          schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
          fetch: { allowedHosts: ["example.com"], allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1 },
          review: { policy: "risk_based" },
          ...(documentType ? { documentType } : {}),
        }],
      }],
    };
    const { revisionId } = await reconcileSourceRegistry(db, registry);
    const [source] = await db.select().from(schema.sources).where(eq(schema.sources.sourceKey, sourceKey));
    const [document] = await db.insert(schema.sourceDocuments).values({
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      logicalDocumentKey: createLogicalDocumentKey(`factsheet-${suffix}`),
      canonicalUrl: `https://example.com/docs/${suffix}.pdf`,
    }).returning();
    const rawSha256 = "a".repeat(64);
    const [artifact] = await db.insert(schema.artifacts).values({
      artifactKey: `raw/${suffix}`,
      uri: `s3://test/${suffix}`,
      sha256: rawSha256,
      byteSize: 10,
      mediaType: "application/pdf",
      producerVersion: "fetch-v1",
      verifiedAt: new Date(),
    }).returning();
    const [version] = await db.insert(schema.documentVersions).values({
      sourceDocumentId: document!.id,
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      sequence: 1,
      contentSha256: rawSha256,
      rawArtifactId: artifact!.id,
      configRevisionId: revisionId,
      readyAt: new Date(),
    }).returning();
    const [run] = await db.insert(schema.pipelineRuns).values({
      documentVersionId: version!.id,
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      implementationVersion: "pipeline-test",
      configRevisionId: revisionId,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-test",
      initialInputChecksum: rawSha256,
      initialMaxAttempts: 3,
    }).returning();
    const parsedSha256 = "b".repeat(64);
    await db.insert(schema.stageAttempts).values({
      pipelineRunId: run!.id,
      documentVersionId: version!.id,
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      stage: "PARSE",
      implementationVersion: "parse-test",
      inputChecksum: rawSha256,
      outputRef: encodeArtifactOutputRef({
        key: `parsed/${suffix}`,
        uri: `s3://test/parsed/${suffix}`,
        sha256: parsedSha256,
        byteSize: 10,
        mediaType: "application/json",
        producerVersion: "parse-test",
      }),
      outputChecksum: parsedSha256,
      status: "succeeded",
      completedAt: new Date(),
    });
    return {
      pipelineRunId: run!.id,
      documentVersionId: version!.id,
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      inputChecksum: parsedSha256,
      signal: new AbortController().signal,
    };
  }

  beforeEach(resetDatabase);
  afterEach(resetDatabase);
  afterAll(async () => client.close());

  test("reads the source document type from the run's immutable registry snapshot", async () => {
    const context = await seedParsedVersion("Factsheet");
    const repository = createDatabaseChunkInspectDocumentRepository(db as unknown as Database);

    const input = await repository.loadInput(context);

    expect(input.documentType).toBe("Factsheet");
    expect(input.parsedArtifact.sha256).toBe(context.inputChecksum);
  });

  test("returns no document type when the source declares none", async () => {
    const context = await seedParsedVersion();
    const repository = createDatabaseChunkInspectDocumentRepository(db as unknown as Database);

    const input = await repository.loadInput(context);

    expect(input.documentType).toBeUndefined();
    expect(Object.hasOwn(input, "documentType")).toBe(false);
  });
});
