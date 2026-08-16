import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { prepareManualChunkEdit } from "../../core/src/chunk-inspection/index.ts";
import * as schema from "./schema.ts";
import {
  applyCandidateEditInspection,
  approveReviewRun,
  getReviewRunDetail,
  stageInspectionReview,
  updateReviewCandidateMetadata,
} from "./review-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("manual candidate editing", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });
  let runId = "";
  let previousCandidateId = "";
  let previousHash = "";
  const ownership = {
    visibilityScope: "GLOBAL" as const,
    tenantId: null,
    ownershipManifestId: "candidate-edit-test",
    ownershipManifestVersion: 1,
  };

  beforeAll(async () => {
    await db.delete(schema.reviewEvents);
    await db.delete(schema.chunkCandidateEdits);
    await db.delete(schema.chunkFlags);
    await db.delete(schema.chunkCandidates);
    await db.delete(schema.ingestionRuns);
    await db.delete(schema.documents);
    const [document] = await db.insert(schema.documents).values({
      filename: "SAI-SIF.pdf",
      filepath: "/tmp/SAI-SIF.pdf",
      fileHash: "1".repeat(64),
      pageCount: 100,
      status: "review_required",
      ...ownership,
    }).returning();
    const previousId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const run = await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: document!.id,
      sourceName: "SAI-SIF.pdf",
      fileHash: "1".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "semantic-v1",
      ownership,
      report: {
        inspectorVersion: "1.0.0",
        candidateChunkCount: 2,
        inspectedChunkCount: 2,
        criticalCount: 1,
        warningCount: 1,
        blockingCount: 1,
        findings: [
          {
            candidateId: previousId,
            chunkIndex: 0,
            ruleCode: "REQUIRED_METADATA_MISSING",
            severity: "warning",
            blocksApproval: false,
            message: "Document scope is unknown.",
            evidence: { field: "documentScope" },
          },
          {
            candidateId: currentId,
            chunkIndex: 1,
            ruleCode: "CROSS_CHUNK_ROW_CONTINUATION",
            severity: "critical",
            blocksApproval: true,
            message: "Boundary split.",
            evidence: {},
          },
        ],
      },
      candidates: [
        {
          id: previousId,
          chunkIndex: 0,
          text: "ETF Mr. Akshay Udeshi Product &",
          pageNumbers: [28],
          tokenCount: 8,
          hasTable: false,
          sectionHeader: null,
          metadata: { documentScope: "unknown", documentType: "SAI" },
          contentHash: "2".repeat(64),
        },
        {
          id: currentId,
          chunkIndex: 1,
          text: "Fund Manager MBA Finance Mr. Akshay Udeshi",
          pageNumbers: [28],
          tokenCount: 8,
          hasTable: false,
          sectionHeader: "Fund Manager",
          metadata: { documentScope: "amc", documentType: "SAI" },
          contentHash: "3".repeat(64),
        },
      ],
    });
    runId = run.id;
    const detail = await getReviewRunDetail(db, runId);
    const previous = detail!.candidates.find((candidate) => candidate.chunkIndex === 0)!;
    previousCandidateId = previous.id;
    previousHash = previous.contentHash;
  });

  afterAll(async () => {
    await client.close();
  });

  test("repairs required metadata in a content review without resolving structural findings", async () => {
    const detail = await getReviewRunDetail(db, runId);
    const candidate = detail!.candidates.find((item) => item.id === previousCandidateId)!;
    await updateReviewCandidateMetadata(db, {
      ingestionRunId: runId,
      candidateId: candidate.id,
      expectedContentHash: candidate.contentHash,
      metadata: { ...candidate.metadata, documentScope: "amc", fundName: "Mirae Asset Test Fund" },
      editor: "reviewer@example.com",
      note: "Resolved the document scope from the verified source title.",
    });

    const refreshed = await getReviewRunDetail(db, runId);
    expect(refreshed?.flags.find((flag) => flag.ruleCode === "REQUIRED_METADATA_MISSING")?.status).toBe("resolved");
    expect(refreshed?.flags.find((flag) => flag.ruleCode === "CROSS_CHUNK_ROW_CONTINUATION")?.status).toBe("open");
    expect(refreshed?.run.warningCount).toBe(0);
    expect(refreshed?.run.blockingCount).toBe(1);
  });

  test("stores the revision and atomically replaces findings after full reinspection", async () => {
    const detail = await getReviewRunDetail(db, runId);
    const prepared = prepareManualChunkEdit({
      document: { id: detail!.run.sourceDocumentId, filename: detail!.run.sourceName, pageCount: 100 },
      candidates: detail!.candidates,
      candidateId: previousCandidateId,
      expectedContentHash: previousHash,
      text: "ETF product team directory.",
    });

    await applyCandidateEditInspection(db, {
      ...prepared,
      ingestionRunId: runId,
      editor: "reviewer@example.com",
      note: "Removed a broken table-row fragment after checking page 28.",
    });

    const refreshed = await getReviewRunDetail(db, runId);
    expect(refreshed?.run.blockingCount).toBe(0);
    expect(refreshed?.run.flaggedChunkCount).toBe(0);
    expect(refreshed?.flags).toHaveLength(0);
    expect(refreshed?.candidates[0]?.text).toBe("ETF product team directory.");
    const [edit] = await db.select().from(schema.chunkCandidateEdits);
    expect(edit?.beforeText).toContain("Akshay Udeshi");
    expect(edit?.afterText).toBe("ETF product team directory.");
    expect(edit?.note).toContain("page 28");
    const events = await db.select().from(schema.reviewEvents);
    expect(events.map((event) => event.eventType)).toContain("chunk_edited");
    expect(events.map((event) => event.eventType)).toContain("inspection_repeated");
  });

  test("rejects a stale edit and any edit after approval", async () => {
    const detail = await getReviewRunDetail(db, runId);
    const candidate = detail!.candidates[0]!;
    const prepared = prepareManualChunkEdit({
      document: { id: detail!.run.sourceDocumentId, filename: detail!.run.sourceName, pageCount: 100 },
      candidates: detail!.candidates,
      candidateId: candidate.id,
      expectedContentHash: candidate.contentHash,
      text: "ETF product team directory, verified.",
    });
    await expect(applyCandidateEditInspection(db, {
      ...prepared,
      beforeContentHash: previousHash,
      ingestionRunId: runId,
      editor: "reviewer@example.com",
      note: "Stale browser tab.",
    })).rejects.toThrow("Chunk changed after this page was loaded.");

    await approveReviewRun(db, runId, "reviewer@example.com", "Ready");

    await expect(applyCandidateEditInspection(db, {
      ...prepared,
      ingestionRunId: runId,
      editor: "reviewer@example.com",
      note: "Should be rejected.",
    })).rejects.toThrow("Only a review-ready run can be edited.");
  });
});
