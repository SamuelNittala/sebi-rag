import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq } from "drizzle-orm";
import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type DesiredSourceRegistry,
} from "@mf-rag/types";

import * as schema from "./schema.ts";
import {
  persistScheduledRiskDecision,
  rejectReviewRun,
  stageInspectionReview,
} from "./review-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("scheduled review lineage", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });
  const suffix = crypto.randomUUID().slice(0, 8);
  const externalCode = `8${Date.now()}`;
  let revisionId = "";
  let accessScopeId = "";
  let sourceId = "";
  let sourceDocumentId = "";
  let artifactId = "";
  let versionId = "";
  let pipelineRunId = "";

  beforeAll(async () => {
    const accessScopeKey = createAccessScopeKey(`scope-${suffix}`);
    const sourceKey = createSourceKey(`site-${suffix}`);
    const desiredState: DesiredSourceRegistry = {
      version: 1 as const,
      accessScopes: [{
        apiVersion: "mf-rag/v1" as const,
        accessScopeKey,
        externalCode: createExternalAccessCode(externalCode),
        classification: {
          knowledgeDomain: "mutual_fund" as const,
          sourceCollection: "mirae_mf" as const,
          amcSlug: "mirae-asset",
        },
        sources: [{
          sourceKey,
          connector: "website_pdf" as const,
          enabled: false,
          discovery: { strategy: "explicit_urls" as const, urls: [] },
          schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
          fetch: {
            allowedHosts: ["example.com"], allowedPathPrefixes: ["/"],
            maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1,
          },
          review: { policy: "risk_based" as const },
        }],
      }],
    };
    const [revision] = await db.insert(schema.sourceRegistryRevisions).values({
      checksum: createHash("sha256").update(suffix).digest("hex"),
      desiredState,
    }).returning();
    revisionId = revision!.id;
    const [scope] = await db.insert(schema.accessScopes).values({
      accessScopeKey,
      externalCode,
      tenantId: externalCode,
      knowledgeDomain: "mutual_fund",
      sourceCollection: "mirae_mf",
      amcSlug: "mirae-asset",
      enabled: false,
      configRevisionId: revisionId,
    }).returning();
    accessScopeId = scope!.id;
    const [source] = await db.insert(schema.sources).values({
      accessScopeId: scope!.id,
      sourceKey,
      connector: "website_pdf",
      discoveryConfig: desiredState.accessScopes[0]!.sources[0]!.discovery,
      fetchConfig: desiredState.accessScopes[0]!.sources[0]!.fetch,
      reviewConfig: desiredState.accessScopes[0]!.sources[0]!.review,
      enabled: false,
      configRevisionId: revisionId,
    }).returning();
    sourceId = source!.id;
    const [document] = await db.insert(schema.sourceDocuments).values({
      accessScopeId: scope!.id,
      sourceId: source!.id,
      logicalDocumentKey: createLogicalDocumentKey(`document-${suffix}`),
      canonicalUrl: `https://example.com/${suffix}.pdf`,
    }).returning();
    sourceDocumentId = document!.id;
    const [artifact] = await db.insert(schema.artifacts).values({
      artifactKey: `raw/${suffix}`,
      uri: `s3://test/${suffix}`,
      sha256: "a".repeat(64),
      byteSize: 10,
      mediaType: "application/pdf",
      producerVersion: "fetch-v1",
      verifiedAt: new Date(),
    }).returning();
    artifactId = artifact!.id;
    const [version] = await db.insert(schema.documentVersions).values({
      sourceDocumentId,
      accessScopeId: scope!.id,
      sourceId: source!.id,
      sequence: 1,
      contentSha256: "a".repeat(64),
      rawArtifactId: artifact!.id,
      configRevisionId: revisionId,
      readyAt: new Date(),
    }).returning();
    versionId = version!.id;
    await db.update(schema.sourceDocuments).set({ currentVersionId: versionId })
      .where(eq(schema.sourceDocuments.id, sourceDocumentId));
    const [run] = await db.insert(schema.pipelineRuns).values({
      documentVersionId: versionId,
      accessScopeId: scope!.id,
      sourceId: source!.id,
      implementationVersion: `pipeline-${suffix}`,
      configRevisionId: revisionId,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v1",
      initialInputChecksum: "a".repeat(64),
      initialMaxAttempts: 3,
    }).returning();
    pipelineRunId = run!.id;
  });

  afterAll(async () => {
    if (!pipelineRunId) {
      await client.close();
      return;
    }
    await db.delete(schema.ingestionRuns).where(eq(schema.ingestionRuns.pipelineRunId, pipelineRunId));
    await db.delete(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, pipelineRunId));
    await db.update(schema.sourceDocuments).set({ currentVersionId: null })
      .where(eq(schema.sourceDocuments.id, sourceDocumentId));
    await db.delete(schema.documentVersions).where(eq(schema.documentVersions.id, versionId));
    await db.delete(schema.artifacts).where(eq(schema.artifacts.id, artifactId));
    await db.delete(schema.sourceDocuments).where(eq(schema.sourceDocuments.id, sourceDocumentId));
    await db.delete(schema.sources).where(eq(schema.sources.id, sourceId));
    await db.delete(schema.accessScopes).where(eq(schema.accessScopes.id, accessScopeId));
    await db.delete(schema.sourceRegistryRevisions).where(eq(schema.sourceRegistryRevisions.id, revisionId));
    await client.close();
  });

  test("reuses one compatible review, persists exact risk evidence, and terminates on rejection", async () => {
    const candidateId = crypto.randomUUID();
    const input = {
      sourceType: "pdf" as const,
      sourceDocumentId,
      documentVersionId: versionId,
      pipelineRunId,
      configRevisionId: revisionId,
      sourceName: "factsheet.pdf",
      sourceLocation: "https://example.com/factsheet.pdf",
      fileHash: "a".repeat(64),
      parserVersion: "unpdf-v1+pdfplumber-v1",
      chunkerVersion: "semantic-v1",
      ownership: {
        visibilityScope: "TENANT" as const,
        tenantId: externalCode,
        ownershipManifestId: `source-registry:${revisionId}`,
        ownershipManifestVersion: 1,
      },
      report: {
        inspectorVersion: "1.0.0",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        criticalCount: 0,
        warningCount: 0,
        blockingCount: 0,
        findings: [],
      },
      candidates: [{
        id: candidateId,
        chunkIndex: 0,
        text: "Reviewed fixture",
        pageNumbers: [1],
        tokenCount: 3,
        hasTable: false,
        sectionHeader: null,
        metadata: { documentScope: "strategy" as const },
        contentHash: "b".repeat(64),
      }],
    };

    const [first, retry] = await Promise.all([
      stageInspectionReview(db, input),
      stageInspectionReview(db, input),
    ]);
    expect(retry.id).toBe(first.id);
    expect(retry).toMatchObject({
      documentVersionId: versionId,
      pipelineRunId,
      configRevisionId: revisionId,
      tenantId: externalCode,
    });
    await expect(stageInspectionReview(db, {
      ...input,
      pipelineRunId: crypto.randomUUID(),
    })).rejects.toThrow("Typed review source document not found");

    const risk = await persistScheduledRiskDecision(db, {
      runId: first.id,
      policyVersion: "document-risk-v1",
      classification: "elevated",
      route: "human_review",
      reasonCodes: ["FIRST_VERSION"],
      actor: "system:risk-policy",
      evidence: {
        isFirstVersion: true,
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        openBlockingCount: 0,
        openWarningCount: 0,
        extractionAnomaly: false,
        ownershipDrift: false,
        configRevisionDrift: false,
        parserVersionDrift: false,
        chunkerVersionDrift: false,
        inspectorVersionDrift: false,
      },
    });
    expect(risk).toMatchObject({
      riskPolicyVersion: "document-risk-v1",
      riskActor: "system:risk-policy",
      riskReasonCodes: ["FIRST_VERSION"],
      documentVersionId: versionId,
    });
    expect((await db.select().from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, pipelineRunId)))[0]?.pausedAt).not.toBeNull();

    await rejectReviewRun(db, first.id, "reviewer@example.com", "Rejected fixture");
    expect((await db.select().from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, pipelineRunId)))[0]).toMatchObject({
      status: "failed",
      pausedAt: null,
    });
    expect(await db.select().from(schema.documentPublicationGenerations)
      .where(eq(schema.documentPublicationGenerations.sourceDocumentId, sourceDocumentId))).toHaveLength(0);
  });
});
