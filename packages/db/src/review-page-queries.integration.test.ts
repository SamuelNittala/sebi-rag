import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { and, eq, inArray } from "drizzle-orm";
import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type DesiredSourceRegistry,
} from "@mf-rag/types";

import * as schema from "./schema.ts";
import {
  getReviewRunPage,
  getReviewRunPageSummary,
  getReviewRunSourceLineage,
  stageInspectionReview,
  type StageInspectionReviewInput,
} from "./review-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

const RAW_SHA = "a".repeat(64);
const OTHER_RAW_SHA = "c".repeat(64);

function descriptorRef(name: string): string {
  return JSON.stringify({
    key: `parsed/${name}`,
    uri: `s3://test/parsed/${name}`,
    sha256: createHash("sha256").update(name).digest("hex"),
    byteSize: 10,
    mediaType: "application/vnd.mf-rag.docling-pdf+json;version=1",
    producerVersion: "parse-test",
  });
}

integrationDescribe("review page view queries", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });
  const suffix = crypto.randomUUID().slice(0, 8);
  const externalCode = `7${Date.now()}`;
  const ids = {
    revision: "",
    scope: "",
    source: "",
    sourceDocument: "",
    legacyDocument: "",
    artifacts: [] as string[],
    versions: [] as string[],
    pipelineRuns: [] as string[],
  };
  // Pipeline runs: `primary` (v1, succeeded PARSE), `reused` (v1, reused PARSE),
  // `failed` (v1, failed PARSE only), `other` (v2).
  const pipeline = { primary: "", reused: "", failed: "", other: "" };
  const reviewRuns = { legacy: "", primary: "", reused: "", failed: "", mismatched: "" };
  const candidateIds: Record<"first" | "spanning" | "last", string> = {
    first: crypto.randomUUID(), spanning: crypto.randomUUID(), last: crypto.randomUUID(),
  };
  let primaryAttemptId = "";

  async function insertPipelineRun(versionId: string, implementationVersion: string): Promise<string> {
    const [run] = await db.insert(schema.pipelineRuns).values({
      documentVersionId: versionId,
      accessScopeId: ids.scope,
      sourceId: ids.source,
      implementationVersion,
      configRevisionId: ids.revision,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-test",
      initialInputChecksum: RAW_SHA,
      initialMaxAttempts: 3,
    }).returning();
    ids.pipelineRuns.push(run!.id);
    return run!.id;
  }

  async function insertParseAttempt(values: {
    pipelineRunId: string;
    versionId: string;
    status: "succeeded" | "reused" | "failed";
    outputRef: string | null;
    inputChecksum: string;
    isCurrent: boolean;
    completedAt: Date;
    reusedAttemptId?: string;
  }): Promise<string> {
    const [attempt] = await db.insert(schema.stageAttempts).values({
      pipelineRunId: values.pipelineRunId,
      documentVersionId: values.versionId,
      accessScopeId: ids.scope,
      sourceId: ids.source,
      stage: "PARSE",
      implementationVersion: "parse-test",
      inputChecksum: values.inputChecksum,
      outputRef: values.outputRef,
      outputChecksum: values.outputRef ? JSON.parse(values.outputRef).sha256 : null,
      status: values.status,
      isCurrent: values.isCurrent,
      completedAt: values.completedAt,
      reusedAttemptId: values.reusedAttemptId,
    }).returning();
    return attempt!.id;
  }

  function scheduledReview(
    pipelineRunId: string,
    parserVersion: string,
    candidates: StageInspectionReviewInput["candidates"],
    findings: StageInspectionReviewInput["report"]["findings"] = [],
  ): StageInspectionReviewInput {
    return {
      sourceType: "pdf",
      sourceDocumentId: ids.sourceDocument,
      documentVersionId: ids.versions[0]!,
      pipelineRunId,
      configRevisionId: ids.revision,
      sourceName: "factsheet.pdf",
      sourceLocation: "https://example.com/factsheet.pdf",
      fileHash: RAW_SHA,
      parserVersion,
      chunkerVersion: "docling-hybrid-v1",
      ownership: {
        visibilityScope: "TENANT",
        tenantId: externalCode,
        ownershipManifestId: `source-registry:${ids.revision}`,
        ownershipManifestVersion: 1,
      },
      report: {
        inspectorVersion: "1.0.0",
        candidateChunkCount: candidates.length,
        inspectedChunkCount: candidates.length,
        criticalCount: findings.filter((finding) => finding.severity === "critical").length,
        warningCount: findings.filter((finding) => finding.severity === "warning").length,
        blockingCount: findings.filter((finding) => finding.blocksApproval).length,
        findings,
      },
      candidates,
    };
  }

  function candidate(id: string, chunkIndex: number, pageNumbers: number[]) {
    return {
      id,
      chunkIndex,
      text: `Candidate ${chunkIndex}`,
      pageNumbers,
      tokenCount: 2,
      hasTable: false,
      sectionHeader: null,
      metadata: { documentScope: "strategy" as const, parser: "docling", sourceItemRefs: [`#/texts/${chunkIndex}`] },
      contentHash: createHash("sha256").update(`${suffix}-${chunkIndex}`).digest("hex"),
    };
  }

  beforeAll(async () => {
    const accessScopeKey = createAccessScopeKey(`page-${suffix}`);
    const sourceKey = createSourceKey(`page-site-${suffix}`);
    const desiredState: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        apiVersion: "mf-rag/v1",
        accessScopeKey,
        externalCode: createExternalAccessCode(externalCode),
        classification: { knowledgeDomain: "mutual_fund", sourceCollection: "mirae_mf", amcSlug: "mirae-asset" },
        sources: [{
          sourceKey,
          connector: "website_pdf",
          enabled: false,
          discovery: { strategy: "explicit_urls", urls: [] },
          schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
          fetch: { allowedHosts: ["example.com"], allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1 },
          review: { policy: "risk_based" },
        }],
      }],
    };
    const [revision] = await db.insert(schema.sourceRegistryRevisions).values({
      checksum: createHash("sha256").update(`page-${suffix}`).digest("hex"),
      desiredState,
    }).returning();
    ids.revision = revision!.id;
    const [scope] = await db.insert(schema.accessScopes).values({
      accessScopeKey,
      externalCode,
      tenantId: externalCode,
      knowledgeDomain: "mutual_fund",
      sourceCollection: "mirae_mf",
      amcSlug: "mirae-asset",
      enabled: false,
      configRevisionId: ids.revision,
    }).returning();
    ids.scope = scope!.id;
    const [source] = await db.insert(schema.sources).values({
      accessScopeId: ids.scope,
      sourceKey,
      connector: "website_pdf",
      discoveryConfig: desiredState.accessScopes[0]!.sources[0]!.discovery,
      fetchConfig: desiredState.accessScopes[0]!.sources[0]!.fetch,
      reviewConfig: desiredState.accessScopes[0]!.sources[0]!.review,
      enabled: false,
      configRevisionId: ids.revision,
    }).returning();
    ids.source = source!.id;
    const [document] = await db.insert(schema.sourceDocuments).values({
      accessScopeId: ids.scope,
      sourceId: ids.source,
      logicalDocumentKey: createLogicalDocumentKey(`page-document-${suffix}`),
      canonicalUrl: `https://example.com/page-${suffix}.pdf`,
    }).returning();
    ids.sourceDocument = document!.id;
    for (const [sequence, sha256] of [[1, RAW_SHA], [2, OTHER_RAW_SHA]] as const) {
      const [artifact] = await db.insert(schema.artifacts).values({
        artifactKey: `raw/page-${suffix}-${sequence}`,
        uri: `s3://test/raw/page-${suffix}-${sequence}`,
        sha256,
        byteSize: 1000 + sequence,
        mediaType: "application/pdf",
        producerVersion: "fetch-v1",
        verifiedAt: new Date(),
      }).returning();
      ids.artifacts.push(artifact!.id);
      const [version] = await db.insert(schema.documentVersions).values({
        sourceDocumentId: ids.sourceDocument,
        accessScopeId: ids.scope,
        sourceId: ids.source,
        sequence,
        contentSha256: sha256,
        rawArtifactId: artifact!.id,
        configRevisionId: ids.revision,
        readyAt: new Date(),
      }).returning();
      ids.versions.push(version!.id);
    }
    const [v1, v2] = ids.versions as [string, string];

    pipeline.primary = await insertPipelineRun(v1, `pipeline-primary-${suffix}`);
    // An older superseded success and a failed retry must not shadow the latest success.
    await insertParseAttempt({
      pipelineRunId: pipeline.primary, versionId: v1, status: "succeeded", outputRef: descriptorRef(`old-${suffix}`),
      inputChecksum: "d".repeat(64), isCurrent: false, completedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await insertParseAttempt({
      pipelineRunId: pipeline.primary, versionId: v1, status: "failed", outputRef: null,
      inputChecksum: "e".repeat(64), isCurrent: false, completedAt: new Date("2026-03-01T00:00:00Z"),
    });
    primaryAttemptId = await insertParseAttempt({
      pipelineRunId: pipeline.primary, versionId: v1, status: "succeeded", outputRef: descriptorRef(`new-${suffix}`),
      inputChecksum: RAW_SHA, isCurrent: true, completedAt: new Date("2026-02-01T00:00:00Z"),
    });
    pipeline.reused = await insertPipelineRun(v1, `pipeline-reused-${suffix}`);
    await insertParseAttempt({
      pipelineRunId: pipeline.reused, versionId: v1, status: "reused", outputRef: descriptorRef(`new-${suffix}`),
      inputChecksum: RAW_SHA, isCurrent: true, completedAt: new Date(), reusedAttemptId: primaryAttemptId,
    });
    pipeline.failed = await insertPipelineRun(v1, `pipeline-failed-${suffix}`);
    await insertParseAttempt({
      pipelineRunId: pipeline.failed, versionId: v1, status: "failed", outputRef: null,
      inputChecksum: RAW_SHA, isCurrent: true, completedAt: new Date(),
    });
    pipeline.other = await insertPipelineRun(v2, `pipeline-other-${suffix}`);
    await insertParseAttempt({
      pipelineRunId: pipeline.other, versionId: v2, status: "succeeded", outputRef: descriptorRef(`other-${suffix}`),
      inputChecksum: OTHER_RAW_SHA, isCurrent: true, completedAt: new Date(),
    });

    const primary = await stageInspectionReview(db, scheduledReview(pipeline.primary, `docling-primary-${suffix}`, [
      candidate(candidateIds.first, 0, [1]),
      candidate(candidateIds.spanning, 1, [1, 2]),
      candidate(candidateIds.last, 2, [3]),
    ], [
      {
        candidateId: candidateIds.first, chunkIndex: 0, ruleCode: "RULE_A", severity: "critical",
        blocksApproval: true, message: "Blocking finding.", evidence: {},
      },
      {
        candidateId: candidateIds.spanning, chunkIndex: 1, ruleCode: "RULE_B", severity: "warning",
        blocksApproval: false, message: "Warning finding.", evidence: {},
      },
      {
        candidateId: candidateIds.spanning, chunkIndex: 1, ruleCode: "RULE_C", severity: "warning",
        blocksApproval: true, message: "Decided finding.", evidence: {},
      },
      {
        candidateId: null, chunkIndex: null, ruleCode: "DOCUMENT_RULE", severity: "info",
        blocksApproval: false, message: "Document-level finding.", evidence: {},
      },
    ]));
    reviewRuns.primary = primary.id;
    // Staging may assign fresh candidate ids; address candidates by chunk index from here on.
    const staged = await db.select().from(schema.chunkCandidates).where(eq(schema.chunkCandidates.ingestionRunId, primary.id));
    const byIndex = new Map(staged.map((row) => [row.chunkIndex, row.id]));
    candidateIds.first = byIndex.get(0)!;
    candidateIds.spanning = byIndex.get(1)!;
    candidateIds.last = byIndex.get(2)!;
    await db.update(schema.chunkFlags).set({ status: "accepted", reviewer: "r", reviewedAt: new Date() })
      .where(and(eq(schema.chunkFlags.ingestionRunId, primary.id), eq(schema.chunkFlags.ruleCode, "RULE_C")));
    for (const n of [1, 2]) {
      await db.insert(schema.chunkCandidateEdits).values({
        ingestionRunId: primary.id,
        chunkCandidateId: candidateIds.spanning,
        chunkIndex: 1,
        beforeText: `before ${n}`,
        afterText: `after ${n}`,
        beforeContentHash: "1".repeat(64),
        afterContentHash: "2".repeat(64),
        editor: "r",
        note: "edit",
      });
    }
    reviewRuns.reused = (await stageInspectionReview(db, scheduledReview(
      pipeline.reused, `docling-reused-${suffix}`, [candidate(crypto.randomUUID(), 0, [1])],
    ))).id;
    reviewRuns.failed = (await stageInspectionReview(db, scheduledReview(
      pipeline.failed, `docling-failed-${suffix}`, [candidate(crypto.randomUUID(), 0, [1])],
    ))).id;
    reviewRuns.mismatched = (await stageInspectionReview(db, scheduledReview(
      pipeline.primary, `docling-mismatch-${suffix}`, [candidate(crypto.randomUUID(), 0, [1])],
    ))).id;
    // Corrupt lineage: the run points at a pipeline run of another document version.
    await db.update(schema.ingestionRuns).set({ pipelineRunId: pipeline.other })
      .where(eq(schema.ingestionRuns.id, reviewRuns.mismatched));

    const legacyOwnership = {
      visibilityScope: "GLOBAL" as const,
      tenantId: null,
      ownershipManifestId: "review-page-query-test",
      ownershipManifestVersion: 1,
    };
    // Unique per run: other suites leave documents with fixed hashes behind.
    const legacyFileHash = createHash("sha256").update(`legacy-${suffix}`).digest("hex");
    const [legacyDocument] = await db.insert(schema.documents).values({
      filename: `legacy-${suffix}.pdf`,
      filepath: `/tmp/legacy-${suffix}.pdf`,
      fileHash: legacyFileHash,
      status: "processing",
      ...legacyOwnership,
    }).returning();
    ids.legacyDocument = legacyDocument!.id;
    reviewRuns.legacy = (await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: ids.legacyDocument,
      sourceName: `legacy-${suffix}.pdf`,
      fileHash: legacyFileHash,
      parserVersion: "unpdf-v1",
      chunkerVersion: "semantic-v1",
      ownership: legacyOwnership,
      report: {
        inspectorVersion: "1.0.0", candidateChunkCount: 1, inspectedChunkCount: 1,
        criticalCount: 0, warningCount: 0, blockingCount: 0, findings: [],
      },
      candidates: [{ ...candidate(crypto.randomUUID(), 0, [1]), metadata: { documentScope: "amc" as const } }],
    })).id;
  });

  afterAll(async () => {
    const runIds = Object.values(reviewRuns).filter(Boolean);
    if (runIds.length) {
      await db.delete(schema.reviewEvents).where(inArray(schema.reviewEvents.ingestionRunId, runIds));
      await db.delete(schema.ingestionRuns).where(inArray(schema.ingestionRuns.id, runIds));
    }
    if (ids.pipelineRuns.length) {
      await db.update(schema.stageAttempts).set({ reusedAttemptId: null })
        .where(inArray(schema.stageAttempts.pipelineRunId, ids.pipelineRuns));
      await db.delete(schema.stageAttempts).where(inArray(schema.stageAttempts.pipelineRunId, ids.pipelineRuns));
      await db.delete(schema.pipelineRuns).where(inArray(schema.pipelineRuns.id, ids.pipelineRuns));
    }
    if (ids.versions.length) await db.delete(schema.documentVersions).where(inArray(schema.documentVersions.id, ids.versions));
    if (ids.artifacts.length) await db.delete(schema.artifacts).where(inArray(schema.artifacts.id, ids.artifacts));
    if (ids.legacyDocument) await db.delete(schema.documents).where(eq(schema.documents.id, ids.legacyDocument));
    if (ids.sourceDocument) await db.delete(schema.sourceDocuments).where(eq(schema.sourceDocuments.id, ids.sourceDocument));
    if (ids.source) await db.delete(schema.sources).where(eq(schema.sources.id, ids.source));
    if (ids.scope) await db.delete(schema.accessScopes).where(eq(schema.accessScopes.id, ids.scope));
    if (ids.revision) {
      await db.delete(schema.sourceRegistryRevisions).where(eq(schema.sourceRegistryRevisions.id, ids.revision));
    }
    await client.close();
  });

  describe("getReviewRunSourceLineage", () => {
    test("returns undefined for an unknown run", async () => {
      expect(await getReviewRunSourceLineage(db, crypto.randomUUID())).toBeUndefined();
    });

    test("a legacy run has no raw artifact, pipeline run or parse output", async () => {
      const lineage = await getReviewRunSourceLineage(db, reviewRuns.legacy);

      expect(lineage?.run.id).toBe(reviewRuns.legacy);
      expect(lineage).toMatchObject({ pipelineRunDocumentVersionId: null, rawArtifact: null, parseOutputRef: null });
    });

    test("a pipeline run returns the version's raw artifact and its latest successful PARSE output", async () => {
      const lineage = await getReviewRunSourceLineage(db, reviewRuns.primary);

      expect(lineage?.run.id).toBe(reviewRuns.primary);
      expect(lineage?.pipelineRunDocumentVersionId).toBe(ids.versions[0]!);
      expect(lineage?.rawArtifact).toEqual({
        key: `raw/page-${suffix}-1`,
        uri: `s3://test/raw/page-${suffix}-1`,
        sha256: RAW_SHA,
        byteSize: 1001,
        mediaType: "application/pdf",
        producerVersion: "fetch-v1",
      });
      expect(lineage?.parseOutputRef).toBe(descriptorRef(`new-${suffix}`));
    });

    test("a reused PARSE attempt provides the copied output reference", async () => {
      const lineage = await getReviewRunSourceLineage(db, reviewRuns.reused);

      expect(lineage?.parseOutputRef).toBe(descriptorRef(`new-${suffix}`));
      expect(lineage?.rawArtifact?.sha256).toBe(RAW_SHA);
    });

    test("a pipeline run without a successful PARSE attempt has no parse output", async () => {
      const lineage = await getReviewRunSourceLineage(db, reviewRuns.failed);

      expect(lineage?.pipelineRunDocumentVersionId).toBe(ids.versions[0]!);
      expect(lineage?.rawArtifact?.sha256).toBe(RAW_SHA);
      expect(lineage?.parseOutputRef).toBeNull();
    });

    test("a pipeline run of another document version yields no parse output and exposes the mismatch", async () => {
      const lineage = await getReviewRunSourceLineage(db, reviewRuns.mismatched);

      expect(lineage?.run.documentVersionId).toBe(ids.versions[0]!);
      expect(lineage?.pipelineRunDocumentVersionId).toBe(ids.versions[1]!);
      expect(lineage?.rawArtifact?.sha256).toBe(RAW_SHA);
      expect(lineage?.parseOutputRef).toBeNull();
    });
  });

  describe("getReviewRunPage", () => {
    test("returns undefined for an unknown run", async () => {
      expect(await getReviewRunPage(db, crypto.randomUUID(), 1)).toBeUndefined();
    });

    test("returns only the candidates on the page, with a multi-page candidate on each of its pages", async () => {
      const pageOne = await getReviewRunPage(db, reviewRuns.primary, 1);
      const pageTwo = await getReviewRunPage(db, reviewRuns.primary, 2);
      const pageFour = await getReviewRunPage(db, reviewRuns.primary, 4);

      expect(pageOne?.run.id).toBe(reviewRuns.primary);
      expect(pageOne?.candidates.map((row) => row.id)).toEqual([candidateIds.first, candidateIds.spanning]);
      expect(pageTwo?.candidates.map((row) => row.id)).toEqual([candidateIds.spanning]);
      expect(pageFour?.candidates).toEqual([]);
      expect(pageFour?.flags).toEqual([]);
    });

    test("returns every flag of the page's candidates (any status) and edit counts per candidate", async () => {
      const pageOne = await getReviewRunPage(db, reviewRuns.primary, 1);
      const pageThree = await getReviewRunPage(db, reviewRuns.primary, 3);

      expect(pageOne?.flags.map((flag) => [flag.ruleCode, flag.status])).toEqual([
        ["RULE_A", "open"],
        ["RULE_B", "open"],
        ["RULE_C", "accepted"],
      ]);
      expect(pageOne?.editCounts).toEqual(new Map([[candidateIds.spanning, 2]]));
      expect(pageThree?.candidates.map((row) => row.id)).toEqual([candidateIds.last]);
      expect(pageThree?.flags).toEqual([]);
      expect(pageThree?.editCounts).toEqual(new Map());
    });
  });

  describe("getReviewRunPageSummary", () => {
    test("counts candidates and open (blocking) flags per page", async () => {
      expect(await getReviewRunPageSummary(db, reviewRuns.primary)).toEqual([
        { page: 1, chunkCount: 2, openFlagCount: 2, openBlockingCount: 1 },
        { page: 2, chunkCount: 1, openFlagCount: 1, openBlockingCount: 0 },
        { page: 3, chunkCount: 1, openFlagCount: 0, openBlockingCount: 0 },
      ]);
    });

    test("is empty for an unknown run", async () => {
      expect(await getReviewRunPageSummary(db, crypto.randomUUID())).toEqual([]);
    });
  });
});
