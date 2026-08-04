import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { and, eq } from "drizzle-orm";
import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type DesiredSourceRegistry,
} from "@mf-rag/types";

import * as schema from "../../../../packages/db/src/schema.ts";
import {
  approveReviewRun,
  persistScheduledRiskDecision,
  rejectReviewRun,
  stageInspectionReview,
  updateReviewRunStatus,
} from "../../../../packages/db/src/review-queries.ts";
import {
  cutoverScheduledPublicationGeneration,
  reactivateScheduledPublicationGeneration,
  stageScheduledPublicationGeneration,
} from "../../../../packages/db/src/scheduled-publication-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("scheduled reviewed publication", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });
  let revisionId = "";
  let accessScopeId = "";
  let sourceId = "";
  let sourceDocumentId = "";
  let externalCode = "";

  async function resetDatabase() {
    await client.unsafe(`TRUNCATE
      document_publication_chunks, document_publication_generations,
      review_events, chunk_flags, chunk_candidates, ingestion_runs,
      stage_attempts, pipeline_runs, document_observations,
      source_document_url_aliases, document_versions, source_documents,
      artifacts, discovery_runs, source_schedules, sources, access_scopes,
      source_registry_revisions, documents
      CASCADE`);
  }

  beforeEach(async () => {
    await resetDatabase();
    const suffix = crypto.randomUUID().slice(0, 8);
    externalCode = `7${Date.now()}`;
    const accessScopeKey = createAccessScopeKey(`publication-${suffix}`);
    const sourceKey = createSourceKey(`documents-${suffix}`);
    const desiredState: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        apiVersion: "mf-rag/v1",
        accessScopeKey,
        externalCode: createExternalAccessCode(externalCode),
        classification: {
          knowledgeDomain: "mutual_fund",
          sourceCollection: "mirae_mf",
          amcSlug: "mirae-asset",
        },
        sources: [{
          sourceKey,
          connector: "website_pdf",
          enabled: false,
          discovery: { strategy: "explicit_urls", urls: [] },
          schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
          fetch: {
            allowedHosts: ["example.com"], allowedPathPrefixes: ["/"],
            maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1,
          },
          review: { policy: "risk_based" },
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
      accessScopeId,
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
      accessScopeId,
      sourceId,
      logicalDocumentKey: createLogicalDocumentKey(`factsheet-${suffix}`),
      canonicalUrl: `https://example.com/${suffix}.pdf`,
    }).returning();
    sourceDocumentId = document!.id;
  });

  afterEach(resetDatabase);
  afterAll(async () => client.close());

  async function createVersion(hex: string, warning = false) {
    const sha256 = hex.repeat(64);
    const [artifact] = await db.insert(schema.artifacts).values({
      artifactKey: `raw/${sha256}`,
      uri: `s3://test/${sha256}`,
      sha256,
      byteSize: 10,
      mediaType: "application/pdf",
      producerVersion: "fetch-v1",
      verifiedAt: new Date(),
    }).returning();
    const existing = await db.select({ sequence: schema.documentVersions.sequence })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.sourceDocumentId, sourceDocumentId));
    const [version] = await db.insert(schema.documentVersions).values({
      sourceDocumentId,
      accessScopeId,
      sourceId,
      sequence: existing.length + 1,
      contentSha256: sha256,
      rawArtifactId: artifact!.id,
      configRevisionId: revisionId,
      readyAt: new Date(),
    }).returning();
    await db.update(schema.sourceDocuments).set({ currentVersionId: version!.id })
      .where(eq(schema.sourceDocuments.id, sourceDocumentId));
    const [pipeline] = await db.insert(schema.pipelineRuns).values({
      documentVersionId: version!.id,
      accessScopeId,
      sourceId,
      implementationVersion: `pipeline-${hex}`,
      configRevisionId: revisionId,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-v1",
      initialInputChecksum: sha256,
      initialMaxAttempts: 3,
    }).returning();
    const candidateId = crypto.randomUUID();
    const review = await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId,
      documentVersionId: version!.id,
      pipelineRunId: pipeline!.id,
      configRevisionId: revisionId,
      sourceName: `factsheet-${hex}.pdf`,
      sourceLocation: `https://example.com/${hex}.pdf`,
      fileHash: sha256,
      parserVersion: "parser-v1",
      chunkerVersion: "chunker-v1",
      ownership: {
        visibilityScope: "TENANT",
        tenantId: externalCode,
        ownershipManifestId: `source-registry:${revisionId}`,
        ownershipManifestVersion: 1,
      },
      report: {
        inspectorVersion: "inspector-v1",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        criticalCount: 0,
        warningCount: warning ? 1 : 0,
        blockingCount: 0,
        findings: warning ? [{
          candidateId,
          chunkIndex: 0,
          ruleCode: "TEST_WARNING",
          severity: "warning",
          blocksApproval: false,
          message: "Review required",
          evidence: {},
        }] : [],
      },
      candidates: [{
        id: candidateId,
        chunkIndex: 0,
        text: `Reviewed version ${hex}`,
        pageNumbers: [1],
        tokenCount: 3,
        hasTable: false,
        sectionHeader: null,
        metadata: { documentScope: "amc", documentType: "Factsheet" },
        contentHash: createHash("sha256").update(`candidate-${hex}`).digest("hex"),
      }],
    });
    return { version: version!, pipeline: pipeline!, review };
  }

  function evidence(first: boolean, warning = false) {
    return {
      isFirstVersion: first,
      candidateChunkCount: 1,
      inspectedChunkCount: 1,
      openBlockingCount: 0,
      openWarningCount: warning ? 1 : 0,
      extractionAnomaly: false,
      ownershipDrift: false,
      configRevisionDrift: false,
      parserVersionDrift: false,
      chunkerVersionDrift: false,
      inspectorVersionDrift: false,
    } as const;
  }

  async function decide(runId: string, first: boolean, warning = false) {
    const human = first || warning;
    return persistScheduledRiskDecision(db, {
      runId,
      policyVersion: "document-risk-v1",
      classification: human ? "elevated" : "low",
      route: human ? "human_review" : "system_approve",
      reasonCodes: first ? ["FIRST_VERSION"] : warning ? ["OPEN_WARNINGS"] : ["CLEAN_ESTABLISHED_UPDATE"],
      evidence: evidence(first, warning),
      actor: "system:risk-policy",
    });
  }

  async function stageGeneration(runId: string) {
    await updateReviewRunStatus(db, runId, "approved", "embedding", "publisher");
    const generation = await stageScheduledPublicationGeneration(db, {
      ingestionRunId: runId,
      chunks: [{
        embedding: new Array(1024).fill(0.1),
        text: `Embedded ${runId}`,
        chunkIndex: 0,
        totalChunks: 1,
        pageNumbers: [1],
        sectionHeader: null,
        hasTable: false,
        metadata: { documentScope: "amc", documentType: "Factsheet" },
      }],
    });
    return generation;
  }

  async function publishFirst(runId: string) {
    await decide(runId, true);
    const approval = await approveReviewRun(db, runId, "reviewer", "Approved baseline");
    expect(approval.approved).toBe(true);
    const generation = await stageGeneration(runId);
    await updateReviewRunStatus(db, runId, "embedding", "staged", "publisher");
    expect(await cutoverScheduledPublicationGeneration(db, runId, "publisher"))
      .toEqual({ status: "published", generationId: generation.id });
    return generation;
  }

  test("fences risk evidence and preserves the prior generation across cutover failures", async () => {
    const first = await createVersion("a");
    await expect(persistScheduledRiskDecision(db, {
      runId: first.review.id,
      policyVersion: "document-risk-v1",
      classification: "low",
      route: "system_approve",
      reasonCodes: ["CLEAN_ESTABLISHED_UPDATE"],
      evidence: evidence(false),
      actor: "system:risk-policy",
    })).rejects.toThrow("evidence does not match");
    const baseline = await publishFirst(first.review.id);

    const second = await createVersion("b");
    await decide(second.review.id, false);
    const secondGeneration = await stageGeneration(second.review.id);
    const stagedAgain = await stageScheduledPublicationGeneration(db, {
      ingestionRunId: second.review.id,
      chunks: [{
        embedding: new Array(1024).fill(0.2), text: "Retry", chunkIndex: 0,
        totalChunks: 1, pageNumbers: [1], sectionHeader: null, hasTable: false,
        metadata: { documentScope: "amc" },
      }],
    });
    expect(stagedAgain.id).toBe(secondGeneration.id);
    expect((await db.select().from(schema.documentPublicationChunks)
      .where(eq(schema.documentPublicationChunks.generationId, secondGeneration.id)))).toHaveLength(1);
    await updateReviewRunStatus(db, second.review.id, "embedding", "staged", "publisher");
    expect((await db.select().from(schema.documentPublicationGenerations)
      .where(eq(schema.documentPublicationGenerations.id, baseline.id)))[0]?.status).toBe("published");
    expect((await cutoverScheduledPublicationGeneration(db, second.review.id, "publisher")).status).toBe("published");
    expect((await cutoverScheduledPublicationGeneration(db, second.review.id, "publisher")).status).toBe("published");
    expect((await db.select().from(schema.documentPublicationGenerations)
      .where(eq(schema.documentPublicationGenerations.id, baseline.id)))[0]?.status).toBe("retired");

    const stale = await createVersion("c");
    await decide(stale.review.id, false);
    const staleGeneration = await stageGeneration(stale.review.id);
    await updateReviewRunStatus(db, stale.review.id, "embedding", "staged", "publisher");
    const frozen = await createVersion("d");
    expect(await cutoverScheduledPublicationGeneration(db, stale.review.id, "publisher"))
      .toEqual({ status: "stale", generationId: staleGeneration.id });
    expect(await cutoverScheduledPublicationGeneration(db, stale.review.id, "publisher"))
      .toEqual({ status: "stale", generationId: staleGeneration.id });
    expect((await db.select().from(schema.documentPublicationGenerations).where(and(
      eq(schema.documentPublicationGenerations.sourceDocumentId, sourceDocumentId),
      eq(schema.documentPublicationGenerations.status, "published"),
    )))[0]?.documentVersionId).toBe(second.version.id);

    await decide(frozen.review.id, false);
    const frozenGeneration = await stageGeneration(frozen.review.id);
    await updateReviewRunStatus(db, frozen.review.id, "embedding", "staged", "publisher");
    await db.update(schema.sources).set({ emergencyFrozenAt: new Date(), emergencyFreezeReason: "test" })
      .where(eq(schema.sources.id, sourceId));
    expect(await cutoverScheduledPublicationGeneration(db, frozen.review.id, "publisher"))
      .toEqual({ status: "frozen", generationId: frozenGeneration.id });
    expect((await db.select().from(schema.documentPublicationGenerations)
      .where(eq(schema.documentPublicationGenerations.id, frozenGeneration.id)))[0]?.status).toBe("staged");
    await db.update(schema.sources).set({ emergencyFrozenAt: null, emergencyFreezeReason: null })
      .where(eq(schema.sources.id, sourceId));
    expect((await cutoverScheduledPublicationGeneration(db, frozen.review.id, "publisher")).status).toBe("published");
    expect(await reactivateScheduledPublicationGeneration(db, {
      sourceDocumentId,
      currentGenerationId: frozenGeneration.id,
      targetGenerationId: secondGeneration.id,
      expectedAccessScopeId: accessScopeId,
      expectedSourceId: sourceId,
      actor: "incident-operator",
      incidentId: "incident-test",
    })).toEqual({
      generationId: secondGeneration.id,
      replacedGenerationId: frozenGeneration.id,
    });

    const partial = await createVersion("e");
    await decide(partial.review.id, false);
    const partialGeneration = await stageGeneration(partial.review.id);
    await updateReviewRunStatus(db, partial.review.id, "embedding", "staged", "publisher");
    await db.delete(schema.documentPublicationChunks)
      .where(eq(schema.documentPublicationChunks.generationId, partialGeneration.id));
    await expect(cutoverScheduledPublicationGeneration(db, partial.review.id, "publisher"))
      .rejects.toThrow("partially staged");
    expect((await db.select().from(schema.documentPublicationGenerations).where(and(
      eq(schema.documentPublicationGenerations.sourceDocumentId, sourceDocumentId),
      eq(schema.documentPublicationGenerations.status, "published"),
    )))[0]?.documentVersionId).toBe(second.version.id);

    const rejected = await createVersion("f", true);
    await decide(rejected.review.id, false, true);
    await rejectReviewRun(db, rejected.review.id, "reviewer", "Rejected warning");
    expect((await db.select().from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, rejected.pipeline.id)))[0]?.status).toBe("failed");
    expect(await db.select().from(schema.documentPublicationGenerations)
      .where(eq(schema.documentPublicationGenerations.ingestionRunId, rejected.review.id))).toHaveLength(0);
    expect((await db.select().from(schema.documentPublicationGenerations).where(and(
      eq(schema.documentPublicationGenerations.sourceDocumentId, sourceDocumentId),
      eq(schema.documentPublicationGenerations.status, "published"),
    )))[0]?.documentVersionId).toBe(second.version.id);
    expect(await db.select().from(schema.documents)).toHaveLength(0);
  });
});
