import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createSourceKey,
  type DesiredSourceRegistry,
  type SourceParseConfig,
} from "@mf-rag/types";

import * as schema from "./schema.ts";
import {
  claimDueDiscoveryRun,
  loadDiscoveryExecutionConfig,
  reconcileSourceRegistry,
} from "./source-registry-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

function desiredRegistry(sourceKeys: readonly string[] = ["factsheets"]): DesiredSourceRegistry {
  const externalCode = createExternalAccessCode("910");
  return {
    version: 1,
    accessScopes: [{
      apiVersion: "mf-rag/v1",
      accessScopeKey: createAccessScopeKey("mirae-sif"),
      externalCode,
      classification: {
        knowledgeDomain: "sif",
        sourceCollection: "mirae_sif",
        amcSlug: "mirae-asset",
      },
      sources: sourceKeys.map((sourceKey) => ({
        sourceKey: createSourceKey(sourceKey),
        connector: "website_pdf" as const,
        enabled: true,
        discovery: {
          strategy: "explicit_urls" as const,
          urls: [{
            key: `${sourceKey}-document` as never,
            url: `https://www.miraeassetmf.co.in/${sourceKey}.pdf`,
          }],
        },
        schedule: {
          enabled: true,
          cron: "0 * * * *",
          timezone: "Asia/Kolkata",
        },
        fetch: {
          allowedHosts: ["www.miraeassetmf.co.in"],
          allowedPathPrefixes: ["/"],
          maxBytes: 10_000_000,
          timeoutMs: 30_000,
          maxRedirects: 3,
        },
        review: { policy: "risk_based" as const },
      })),
    }],
  };
}

integrationDescribe("source registry control plane", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });

  beforeEach(async () => {
    await db.delete(schema.discoveryRuns);
    await db.delete(schema.sourceSchedules);
    await db.delete(schema.sources);
    await db.delete(schema.accessScopes);
    await db.delete(schema.sourceRegistryRevisions);
  });

  afterAll(async () => {
    await client.close();
  });

  test("reapplying the same checksum is idempotent", async () => {
    const [first, concurrent] = await Promise.all([
      reconcileSourceRegistry(db, desiredRegistry()),
      reconcileSourceRegistry(db, desiredRegistry()),
    ]);
    const second = await reconcileSourceRegistry(db, desiredRegistry());

    expect(second.revisionId).toBe(first.revisionId);
    expect(concurrent.revisionId).toBe(first.revisionId);
    expect(second.changed).toBe(false);
    expect(await db.select().from(schema.sourceRegistryRevisions)).toHaveLength(1);
    expect(await db.select().from(schema.sources)).toHaveLength(1);
  });

  test("reconcile persists parse_config, null when the manifest omits parse", async () => {
    const withParse = (parse?: SourceParseConfig): DesiredSourceRegistry => {
      const registry = desiredRegistry(["factsheets", "scheme-documents"]);
      const scope = registry.accessScopes[0]!;
      return {
        version: 1,
        accessScopes: [{
          ...scope,
          sources: scope.sources.map((source) => (
            source.sourceKey === "factsheets" && parse ? { ...source, parse } : source
          )),
        }],
      };
    };
    const parseConfigs = async () => Object.fromEntries((await db.select().from(schema.sources))
      .map((source) => [source.sourceKey, source.parseConfig]));

    await reconcileSourceRegistry(db, withParse({ parser: "docling" }));
    expect(await parseConfigs()).toEqual({ factsheets: { parser: "docling" }, "scheme-documents": null });

    await reconcileSourceRegistry(db, withParse({ parser: "docling", fundNamePrefixes: ["Mirae Asset"] }));
    expect(await parseConfigs()).toEqual({
      factsheets: { parser: "docling", fundNamePrefixes: ["Mirae Asset"] },
      "scheme-documents": null,
    });

    await reconcileSourceRegistry(db, withParse());
    expect(await parseConfigs()).toEqual({ factsheets: null, "scheme-documents": null });
  });

  test("a claimed run resolves fetch rules from its immutable revision and rejects revision drift", async () => {
    const first = await reconcileSourceRegistry(db, desiredRegistry());
    const [source] = await db.select().from(schema.sources);
    const [run] = await db.insert(schema.discoveryRuns).values({
      sourceId: source!.id, configRevisionId: first.revisionId,
      scheduledFor: new Date("2026-08-04T00:00:00Z"), status: "running",
      leaseOwner: "worker-a", leaseEpoch: 1, attemptCount: 1,
    }).returning();
    const original = desiredRegistry();
    const manifest = original.accessScopes[0]!;
    const sourceManifest = manifest.sources[0]!;
    const changed: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        ...manifest,
        sources: [{ ...sourceManifest, fetch: { ...sourceManifest.fetch, maxBytes: 20_000_000 } }],
      }],
    };
    const second = await reconcileSourceRegistry(db, changed);
    expect((await loadDiscoveryExecutionConfig(db, {
      discoveryRunId: run!.id, sourceId: source!.id, configRevisionId: first.revisionId,
      owner: "worker-a", leaseEpoch: 1,
    })).fetch.maxBytes).toBe(10_000_000);
    await expect(loadDiscoveryExecutionConfig(db, {
      discoveryRunId: run!.id, sourceId: source!.id, configRevisionId: second.revisionId,
      owner: "worker-a", leaseEpoch: 1,
    })).rejects.toThrow(/revision|fence/i);
  });

  test("a database reconciliation failure rolls back the revision and every source change", async () => {
    const baseline = await reconcileSourceRegistry(db, desiredRegistry());
    const [baselineSource] = await db.select().from(schema.sources);
    const conflicting = desiredRegistry(["replacement"]);
    const renamed = {
      ...conflicting,
      accessScopes: [{
        ...conflicting.accessScopes[0]!,
        accessScopeKey: createAccessScopeKey("renamed-scope"),
      }],
    };

    await expect(reconcileSourceRegistry(db, renamed)).rejects.toThrow();

    const [active] = await db.select().from(schema.sourceRegistryRevisions)
      .where(eq(schema.sourceRegistryRevisions.isActive, true));
    const storedSources = await db.select().from(schema.sources);
    expect(active?.id).toBe(baseline.revisionId);
    expect(await db.select().from(schema.sourceRegistryRevisions)).toHaveLength(1);
    expect(storedSources).toHaveLength(1);
    expect(storedSources[0]?.id).toBe(baselineSource?.id);
    expect(storedSources[0]?.sourceKey).toBe("factsheets");
  });

  test("removing a source disables it and preserves discovery history", async () => {
    await reconcileSourceRegistry(db, desiredRegistry(["factsheets", "scheme-documents"]));
    const initialSources = await db.select().from(schema.sources);
    const removed = initialSources.find((source) => source.sourceKey === "scheme-documents")!;
    await db.insert(schema.discoveryRuns).values({
      sourceId: removed.id,
      configRevisionId: removed.configRevisionId,
      scheduledFor: new Date("2026-08-04T00:00:00.000Z"),
      status: "succeeded",
      startedAt: new Date("2026-08-04T00:00:00.000Z"),
      completedAt: new Date("2026-08-04T00:00:01.000Z"),
    });

    await reconcileSourceRegistry(db, desiredRegistry(["factsheets"]));

    const [stored] = await db.select().from(schema.sources);
    const disabled = (await db.select().from(schema.sources))
      .find((source) => source.sourceKey === "scheme-documents");
    expect(stored).toBeDefined();
    expect(disabled?.enabled).toBe(false);
    expect(await db.select().from(schema.discoveryRuns)).toHaveLength(1);
  });

  test("two concurrent claims create one discovery run and disabled sources stay unclaimable", async () => {
    await reconcileSourceRegistry(db, desiredRegistry());
    const now = new Date("2026-08-04T10:30:00.000Z");
    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-04T09:00:00.000Z") });

    const [first, second] = await Promise.all([
      claimDueDiscoveryRun(db, { now }),
      claimDueDiscoveryRun(db, { now }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(schema.discoveryRuns)).toHaveLength(1);

    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-04T10:00:00.000Z") });
    expect(await claimDueDiscoveryRun(db, { now })).toBeNull();

    await db.update(schema.sources).set({ enabled: false });
    await db.update(schema.sourceSchedules).set({ nextDueAt: new Date("2026-08-04T10:00:00.000Z") });
    expect(await claimDueDiscoveryRun(db, { now })).toBeNull();

    await db.update(schema.sources).set({ enabled: true });
    await db.update(schema.sourceSchedules).set({ enabled: false });
    expect(await claimDueDiscoveryRun(db, { now })).toBeNull();
  });

  test("keeps existing 910 and 117 API-key grants compatible", async () => {
    const fingerprint = "f".repeat(64);
    const [apiKey] = await db.insert(schema.apiKeys).values({
      keyFingerprint: fingerprint,
      name: "source-registry-compatibility-test",
    }).onConflictDoUpdate({
      target: schema.apiKeys.keyFingerprint,
      set: { isActive: true },
    }).returning();
    await db.insert(schema.apiKeyTenantScopes).values([
      { apiKeyId: apiKey!.id, tenantId: "910" },
      { apiKeyId: apiKey!.id, tenantId: "117" },
    ]).onConflictDoNothing();

    await reconcileSourceRegistry(db, desiredRegistry());

    const grants = await db.select().from(schema.apiKeyTenantScopes)
      .where(eq(schema.apiKeyTenantScopes.apiKeyId, apiKey!.id));
    expect(grants.map((grant) => grant.tenantId).sort()).toEqual(["117", "910"]);
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey!.id));
  });
});
