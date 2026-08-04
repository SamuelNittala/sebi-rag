import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";

import {
  createAccessScopeKey,
  createExternalAccessCode,
  createSourceKey,
  type DesiredSourceRegistry,
} from "@mf-rag/types";

import {
  auditLegacyDocumentVersionReadiness,
  compareAndSetCurrentDocumentVersion,
  findOrCreateSourceDocument,
  findOrCreateSourceDocumentForDiscovery,
  findSourceDocumentFetchState,
  ensureDocumentVersionPipelineForDiscovery,
  recordDocumentObservation,
  recordFetchedDocumentVersion,
  recordFetchedDocumentVersionAndEnsurePipeline,
  recordSourceDocumentAlias,
  recordSuccessfulDocumentObservations,
} from "./document-version-queries.ts";
import { reconcileSourceRegistry } from "./source-registry-queries.ts";
import * as schema from "./schema.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

function registry(): DesiredSourceRegistry {
  return {
    version: 1,
    accessScopes: ["910", "117"].map((code) => ({
      apiVersion: "mf-rag/v1" as const,
      accessScopeKey: createAccessScopeKey(code === "910" ? "mirae-sif" : "mirae-mf"),
      externalCode: createExternalAccessCode(code),
      classification: {
        knowledgeDomain: code === "910" ? "sif" : "mutual_fund",
        sourceCollection: code === "910" ? "mirae_sif" : "mirae_mf",
        amcSlug: "mirae-asset",
      },
      sources: [{
        sourceKey: createSourceKey("documents"),
        connector: "website_pdf" as const,
        enabled: false,
        discovery: { strategy: "explicit_urls" as const, urls: [] },
        schedule: { enabled: false, cron: "0 * * * *", timezone: "Asia/Kolkata" },
        fetch: {
          allowedHosts: ["www.miraeassetmf.co.in"],
          allowedPathPrefixes: ["/"],
          maxBytes: 10_000_000,
          timeoutMs: 30_000,
          maxRedirects: 3,
        },
        review: { policy: "risk_based" as const },
      }],
    })),
  };
}

function artifact(sha256: string) {
  return {
    key: `raw/${sha256.slice(0, 2)}/${sha256}`,
    uri: `s3://test/raw/${sha256}`,
    sha256,
    byteSize: 100,
    mediaType: "application/pdf",
    producerVersion: "fetch-v1",
  };
}

integrationDescribe("document version registry", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });

  beforeEach(async () => {
    await db.delete(schema.documentObservations);
    await db.delete(schema.stageAttempts);
    await db.delete(schema.pipelineRuns);
    await db.update(schema.sourceDocuments).set({ currentVersionId: null });
    await db.delete(schema.documentVersions);
    await db.delete(schema.sourceDocumentUrlAliases);
    await db.delete(schema.sourceDocuments);
    await db.delete(schema.artifacts);
    await db.delete(schema.discoveryRuns);
    await db.delete(schema.sourceSchedules);
    await db.delete(schema.sources);
    await db.delete(schema.accessScopes);
    await db.delete(schema.sourceRegistryRevisions);
    await reconcileSourceRegistry(db, registry());
  });

  afterAll(async () => client.close());

  async function ownedSource(code: "910" | "117") {
    const [scope] = await db.select().from(schema.accessScopes).where(eq(schema.accessScopes.externalCode, code));
    const [source] = await db.select().from(schema.sources).where(eq(schema.sources.accessScopeId, scope!.id));
    return { scope: scope!, source: source! };
  }

  test("unchanged bytes return one version and one observation without downstream identity churn", async () => {
    const { scope, source } = await ownedSource("910");
    const doc = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id,
      sourceId: source.id,
      logicalDocumentKey: "factsheet:alpha",
      canonicalUrl: "https://www.miraeassetmf.co.in/alpha.pdf",
    });
    const hash = "a".repeat(64);
    const first = await recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(hash) });
    const second = await recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(hash) });

    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
    expect(await db.select().from(schema.documentVersions)).toHaveLength(1);

    const [run] = await db.insert(schema.discoveryRuns).values({
      sourceId: source.id,
      configRevisionId: source.configRevisionId,
      scheduledFor: new Date("2026-08-04T00:00:00Z"),
      status: "succeeded",
    }).returning();
    await recordDocumentObservation(db, { discoveryRunId: run!.id, sourceDocumentId: doc.id, observedUrl: doc.canonicalUrl, etag: "etag-1" });
    await recordDocumentObservation(db, { discoveryRunId: run!.id, sourceDocumentId: doc.id, observedUrl: doc.canonicalUrl, etag: "etag-1" });
    expect(await db.select().from(schema.documentObservations)).toHaveLength(1);
  });

  test("stores validators/aliases and writes presence only as one complete running-run batch", async () => {
    const { scope, source } = await ownedSource("910");
    const first = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id, sourceId: source.id,
      logicalDocumentKey: "factsheet:observed",
      canonicalUrl: "https://www.miraeassetmf.co.in/observed.pdf",
    });
    await recordFetchedDocumentVersion(db, {
      sourceDocumentId: first.id,
      artifact: artifact("9".repeat(64)),
      etag: '"version-9"',
      lastModified: "Tue, 04 Aug 2026 00:00:00 GMT",
    });
    expect(await findSourceDocumentFetchState(db, {
      accessScopeId: scope.id, sourceId: source.id, logicalDocumentKey: "factsheet:observed",
    })).toMatchObject({
      sourceDocumentId: first.id,
      currentSha256: "9".repeat(64),
      etag: '"version-9"',
    });
    const [running] = await db.insert(schema.discoveryRuns).values({
      sourceId: source.id, configRevisionId: source.configRevisionId,
      scheduledFor: new Date("2026-08-04T01:00:00Z"), status: "running",
      leaseOwner: "worker-a", leaseEpoch: 1, attemptCount: 1,
    }).returning();
    const fence = { discoveryRunId: running!.id, owner: "worker-a", leaseEpoch: 1 };
    await recordSourceDocumentAlias(db, {
      fence,
      accessScopeId: scope.id, sourceId: source.id, sourceDocumentId: first.id,
      aliasUrl: "https://www.miraeassetmf.co.in/redirected/observed.pdf#fragment",
    });

    const second = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id, sourceId: source.id,
      logicalDocumentKey: "factsheet:other",
      canonicalUrl: "https://www.miraeassetmf.co.in/other.pdf",
    });
    await expect(recordSourceDocumentAlias(db, {
      fence,
      accessScopeId: scope.id, sourceId: source.id, sourceDocumentId: second.id,
      aliasUrl: "https://www.miraeassetmf.co.in/redirected/observed.pdf",
    })).rejects.toThrow(/already owned/i);

    await recordSuccessfulDocumentObservations(db, {
      ...fence,
      observations: [{
        sourceDocumentId: first.id,
        observedUrl: "https://www.miraeassetmf.co.in/redirected/observed.pdf",
        etag: '"version-9"', lastModified: null,
      }],
    });
    expect(await db.select().from(schema.documentObservations)).toHaveLength(1);
    expect((await db.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, running!.id)))[0]?.status)
      .toBe("succeeded");

    const [failed] = await db.insert(schema.discoveryRuns).values({
      sourceId: source.id, configRevisionId: source.configRevisionId,
      scheduledFor: new Date("2026-08-04T02:00:00Z"), status: "failed",
    }).returning();
    await expect(recordSuccessfulDocumentObservations(db, {
      discoveryRunId: failed!.id,
      owner: "worker-a", leaseEpoch: 1,
      observations: [{ sourceDocumentId: second.id, observedUrl: second.canonicalUrl }],
    })).rejects.toThrow(/stale/i);
    expect(await db.select().from(schema.documentObservations)).toHaveLength(1);
  });

  test("stale discovery owners cannot write identity, versions, PARSE work, aliases, or observations", async () => {
    const { scope, source } = await ownedSource("910");
    const document = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id, sourceId: source.id, logicalDocumentKey: "factsheet:fenced-fetch",
      canonicalUrl: "https://www.miraeassetmf.co.in/fenced-fetch.pdf",
    });
    const [run] = await db.insert(schema.discoveryRuns).values({
      sourceId: source.id, configRevisionId: source.configRevisionId,
      scheduledFor: new Date("2026-08-04T03:00:00Z"), status: "running",
      leaseOwner: "worker-a", leaseEpoch: 1, attemptCount: 1,
    }).returning();
    const stale = { discoveryRunId: run!.id, owner: "worker-a", leaseEpoch: 1 };
    const current = { discoveryRunId: run!.id, owner: "worker-b", leaseEpoch: 2 };
    await db.update(schema.discoveryRuns).set({ leaseOwner: "worker-b", leaseEpoch: 2 })
      .where(eq(schema.discoveryRuns.id, run!.id));
    const input = {
      fence: stale, sourceDocumentId: document.id, artifact: artifact("8".repeat(64)),
      pipelineIdentity: { pipelineImplementationVersion: "pipeline-v1", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
    };
    await expect(recordFetchedDocumentVersionAndEnsurePipeline(db, input)).rejects.toThrow(/stale/i);
    await expect(recordSourceDocumentAlias(db, {
      fence: stale, accessScopeId: scope.id, sourceId: source.id, sourceDocumentId: document.id,
      aliasUrl: "https://www.miraeassetmf.co.in/stale-alias.pdf",
    })).rejects.toThrow(/stale/i);
    await expect(recordSuccessfulDocumentObservations(db, {
      ...stale, observations: [{ sourceDocumentId: document.id, observedUrl: document.canonicalUrl }],
    })).rejects.toThrow(/stale/i);
    expect(await db.select().from(schema.documentVersions)).toHaveLength(0);
    expect(await db.select().from(schema.pipelineRuns)).toHaveLength(0);

    const [otherSource] = await db.insert(schema.sources).values({
      accessScopeId: scope.id, sourceKey: "other-documents", connector: "website_pdf",
      discoveryConfig: { strategy: "explicit_urls", urls: [] },
      fetchConfig: source.fetchConfig, reviewConfig: source.reviewConfig,
      enabled: false, configRevisionId: source.configRevisionId,
    }).returning();
    const otherDocument = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id, sourceId: otherSource!.id, logicalDocumentKey: "factsheet:other-source",
      canonicalUrl: "https://www.miraeassetmf.co.in/other-source.pdf",
    });
    await expect(findOrCreateSourceDocumentForDiscovery(db, {
      fence: current, accessScopeId: scope.id, sourceId: otherSource!.id,
      logicalDocumentKey: "factsheet:cross-source-write",
      canonicalUrl: "https://www.miraeassetmf.co.in/cross-source-write.pdf",
    })).rejects.toThrow(/another source/i);
    await expect(recordFetchedDocumentVersionAndEnsurePipeline(db, {
      ...input, fence: current, sourceDocumentId: otherDocument.id,
    })).rejects.toThrow(/another source/i);

    const accepted = await recordFetchedDocumentVersionAndEnsurePipeline(db, { ...input, fence: current });
    expect(accepted.created).toBe(true);
    await ensureDocumentVersionPipelineForDiscovery(db, {
      fence: current, documentVersionId: accepted.version.id, inputChecksum: accepted.version.contentSha256,
      pipelineIdentity: { pipelineImplementationVersion: "pipeline-v2", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
    });
    expect(await db.select().from(schema.documentVersions)).toHaveLength(1);
    expect(await db.select().from(schema.pipelineRuns)).toHaveLength(2);
    expect(await db.select().from(schema.stageAttempts)).toHaveLength(2);
  });

  test("identical bytes in 910 and 117 remain separate owned versions", async () => {
    const hash = "b".repeat(64);
    const versions = [];
    for (const code of ["910", "117"] as const) {
      const { scope, source } = await ownedSource(code);
      const doc = await findOrCreateSourceDocument(db, {
        accessScopeId: scope.id,
        sourceId: source.id,
        logicalDocumentKey: "factsheet:shared",
        canonicalUrl: `https://www.miraeassetmf.co.in/${code}/shared.pdf`,
      });
      versions.push((await recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(hash) })).version);
    }

    expect(versions[0]!.id).not.toBe(versions[1]!.id);
    expect(versions[0]!.accessScopeId).not.toBe(versions[1]!.accessScopeId);
    expect(await db.select().from(schema.artifacts)).toHaveLength(1);
  });

  test("concurrent same-hash inserts create one version; changed payload advances exactly once", async () => {
    const { scope, source } = await ownedSource("910");
    const doc = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id,
      sourceId: source.id,
      logicalDocumentKey: "factsheet:concurrent",
      canonicalUrl: "https://www.miraeassetmf.co.in/concurrent.pdf",
    });
    const hash = "c".repeat(64);
    const [left, right] = await Promise.all([
      recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(hash) }),
      recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(hash) }),
    ]);
    expect(left.version.id).toBe(right.version.id);

    const changedHash = "d".repeat(64);
    const [changedLeft, changedRight] = await Promise.all([
      recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(changedHash) }),
      recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact(changedHash) }),
    ]);
    expect(changedLeft.version.id).toBe(changedRight.version.id);
    expect(changedLeft.version.sequence).toBe(2);
    const [refreshed] = await db.select().from(schema.sourceDocuments).where(eq(schema.sourceDocuments.id, doc.id));
    expect(refreshed!.currentVersionId).toBe(changedLeft.version.id);
    expect(await db.select().from(schema.documentVersions)).toHaveLength(2);
  });

  test("explicit current-version CAS rejects an older version after a newer observation", async () => {
    const { scope, source } = await ownedSource("910");
    const doc = await findOrCreateSourceDocument(db, {
      accessScopeId: scope.id,
      sourceId: source.id,
      logicalDocumentKey: "factsheet:fenced",
      canonicalUrl: "https://www.miraeassetmf.co.in/fenced.pdf",
    });
    const first = (await recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact("e".repeat(64)) })).version;
    const second = (await recordFetchedDocumentVersion(db, { sourceDocumentId: doc.id, artifact: artifact("f".repeat(64)) })).version;

    const replayedOlder = await recordFetchedDocumentVersion(db, {
      sourceDocumentId: doc.id,
      artifact: artifact("e".repeat(64)),
    });
    expect(replayedOlder.created).toBe(false);
    expect(replayedOlder.version.id).toBe(first.id);

    await expect(compareAndSetCurrentDocumentVersion(db, {
      sourceDocumentId: doc.id,
      expectedCurrentVersionId: second.id,
      proposedVersionId: first.id,
    })).resolves.toBe(false);
    const [refreshed] = await db.select().from(schema.sourceDocuments).where(eq(schema.sourceDocuments.id, doc.id));
    expect(refreshed!.currentVersionId).toBe(second.id);
  });

  test("fails closed when source ownership or a canonical URL conflicts", async () => {
    const owned910 = await ownedSource("910");
    const owned117 = await ownedSource("117");
    await expect(findOrCreateSourceDocument(db, {
      accessScopeId: owned117.scope.id,
      sourceId: owned910.source.id,
      logicalDocumentKey: "wrong-owner",
      canonicalUrl: "https://www.miraeassetmf.co.in/wrong-owner.pdf",
    })).rejects.toThrow("ownership");
    await expect(findOrCreateSourceDocument(db, {
      accessScopeId: owned910.scope.id,
      sourceId: owned910.source.id,
      logicalDocumentKey: "credentialed-url",
      canonicalUrl: "https://user:secret@www.miraeassetmf.co.in/private.pdf",
    })).rejects.toThrow("credentials");

    await findOrCreateSourceDocument(db, {
      accessScopeId: owned910.scope.id,
      sourceId: owned910.source.id,
      logicalDocumentKey: "one",
      canonicalUrl: "https://www.miraeassetmf.co.in/collision.pdf",
    });
    await expect(findOrCreateSourceDocument(db, {
      accessScopeId: owned910.scope.id,
      sourceId: owned910.source.id,
      logicalDocumentKey: "two",
      canonicalUrl: "https://www.miraeassetmf.co.in/collision.pdf",
    })).rejects.toThrow("canonical URL");
  });

  test("reports ambiguous legacy identity and null ownership without mutating legacy rows", async () => {
    const sharedUrl = "https://legacy.example.test/ambiguous.pdf";
    const uniqueHash = () => crypto.randomUUID().replaceAll("-", "").repeat(2);
    const inserted = await db.insert(schema.documents).values([
      {
        filename: "legacy-one.pdf",
        filepath: "/legacy/one.pdf",
        fileHash: uniqueHash(),
        sourceUrl: sharedUrl,
      },
      {
        filename: "legacy-two.pdf",
        filepath: "/legacy/two.pdf",
        fileHash: uniqueHash(),
        sourceUrl: sharedUrl,
      },
    ]).returning();
    try {
      const issues = await auditLegacyDocumentVersionReadiness(db);
      expect(issues.some((issue) =>
        issue.kind === "AMBIGUOUS_CANONICAL_URL"
        && issue.value === sharedUrl
        && inserted.every((row) => issue.legacyDocumentIds.includes(row.id))
      )).toBe(true);
      expect(issues.filter((issue) =>
        issue.kind === "UNRESOLVED_OWNERSHIP"
        && inserted.some((row) => issue.legacyDocumentIds.includes(row.id))
      )).toHaveLength(2);
      const stored = await db.select().from(schema.documents)
        .where(eq(schema.documents.sourceUrl, sharedUrl));
      expect(stored.every((row) => row.visibilityScope === "UNCLASSIFIED" && row.documentVersionId === null)).toBe(true);
    } finally {
      for (const row of inserted) {
        await db.delete(schema.documents).where(eq(schema.documents.id, row.id));
      }
    }
  });
});
