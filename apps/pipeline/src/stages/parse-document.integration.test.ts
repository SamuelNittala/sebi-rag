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
} from "@mf-rag/types";
import type { Database } from "@mf-rag/db";

import * as schema from "../../../../packages/db/src/schema.ts";
import { reconcileSourceRegistry } from "../../../../packages/db/src/source-registry-queries.ts";
import { createDatabaseParseDocumentRepository } from "./parse-document.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("PARSE input parser selection", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });

  async function resetDatabase() {
    await client.unsafe(`TRUNCATE
      document_versions, source_documents, artifacts, discovery_runs,
      source_schedules, sources, access_scopes, source_registry_revisions
      CASCADE`);
  }

  async function seedVersion(parse?: { parser: "unpdf" | "docling" }) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const sourceKey = createSourceKey(`factsheets-${suffix}`);
    const registry: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        apiVersion: "mf-rag/v1",
        accessScopeKey: createAccessScopeKey(`parse-${suffix}`),
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
          ...(parse ? { parse } : {}),
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
    const sha256 = "a".repeat(64);
    const [artifact] = await db.insert(schema.artifacts).values({
      artifactKey: `raw/${suffix}`,
      uri: `s3://test/${suffix}`,
      sha256,
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
      contentSha256: sha256,
      rawArtifactId: artifact!.id,
      configRevisionId: revisionId,
      readyAt: new Date(),
    }).returning();
    return {
      pipelineRunId: crypto.randomUUID(),
      documentVersionId: version!.id,
      accessScopeId: source!.accessScopeId,
      sourceId: source!.id,
      inputChecksum: sha256,
      signal: new AbortController().signal,
    };
  }

  beforeEach(resetDatabase);
  afterEach(resetDatabase);
  afterAll(async () => client.close());

  test.each([
    ["docling", { parser: "docling" as const }],
    ["unpdf", { parser: "unpdf" as const }],
    ["unpdf", undefined],
  ])("returns %s for parse config %p", async (expected, parse) => {
    const context = await seedVersion(parse);
    const repository = createDatabaseParseDocumentRepository(db as unknown as Database);

    const input = await repository.loadInput(context);

    expect(input.parser).toBe(expected as "unpdf" | "docling");
    expect(input.filename).toMatch(/\.pdf$/);
  });
});
