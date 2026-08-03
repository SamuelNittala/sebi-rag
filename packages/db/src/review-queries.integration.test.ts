import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema.ts";
import {
  approveReviewRun,
  decideChunkFlag,
  getReviewRunDetail,
  publishReviewRun,
  stageInspectionReview,
  updateReviewRunStatus,
} from "./review-queries.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("chunk review persistence", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema });
  let documentId = "";
  const ownership = {
    visibilityScope: "GLOBAL" as const,
    tenantId: null,
    ownershipManifestId: "review-query-test",
    ownershipManifestVersion: 1,
  };

  beforeAll(async () => {
    await db.delete(schema.reviewEvents);
    await db.delete(schema.chunkFlags);
    await db.delete(schema.chunkCandidates);
    await db.delete(schema.ingestionRuns);
    await db.delete(schema.documents);
    const [document] = await db.insert(schema.documents).values({
      filename: "SAI-SIF_March-2026.pdf",
      filepath: "/tmp/SAI-SIF_March-2026.pdf",
      fileHash: "a".repeat(64),
      status: "processing",
      ...ownership,
    }).returning();
    documentId = document!.id;
  });

  afterAll(async () => {
    await client.close();
  });

  test("stores every candidate and inspection finding before embedding", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const run = await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: documentId,
      sourceName: "SAI-SIF_March-2026.pdf",
      sourceLocation: "/tmp/SAI-SIF_March-2026.pdf",
      fileHash: "a".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "semantic-v1",
      ownership,
      report: {
        inspectorVersion: "1.0.0",
        candidateChunkCount: 2,
        inspectedChunkCount: 2,
        criticalCount: 1,
        warningCount: 0,
        blockingCount: 1,
        findings: [{
          candidateId: secondId,
          chunkIndex: 1,
          ruleCode: "CROSS_CHUNK_ROW_CONTINUATION",
          severity: "critical",
          blocksApproval: true,
          message: "A row continues across the boundary.",
          evidence: { previousChunkIndex: 0 },
        }],
      },
      candidates: [
        {
          id: firstId,
          chunkIndex: 0,
          text: "ETF Mr. Akshay Udeshi 30 years ETF Product &",
          pageNumbers: [28],
          tokenCount: 9,
          hasTable: false,
          sectionHeader: null,
          metadata: { documentScope: "amc", documentType: "SAI" },
          contentHash: "b".repeat(64),
        },
        {
          id: secondId,
          chunkIndex: 1,
          text: "Fund Manager MBA Finance 6 years Mr. Akshay Udeshi",
          pageNumbers: [28, 29],
          tokenCount: 9,
          hasTable: false,
          sectionHeader: "Fund Manager",
          metadata: { documentScope: "amc", documentType: "SAI" },
          contentHash: "c".repeat(64),
        },
      ],
    });

    const detail = await getReviewRunDetail(db, run.id);

    expect(detail?.run.status).toBe("review_ready");
    expect(detail?.candidates).toHaveLength(2);
    expect(detail?.flags).toHaveLength(1);
    expect(detail?.flags[0]?.ruleCode).toBe("CROSS_CHUNK_ROW_CONTINUATION");
    expect(detail?.candidates[0]?.pageNumbers).toEqual([28]);
    expect(detail?.candidates[0]?.metadata).toMatchObject({
      documentScope: "amc",
      documentType: "SAI",
    });
    expect(detail?.flags[0]?.evidence).toEqual({ previousChunkIndex: 0 });
    expect(detail?.events[0]?.details).toMatchObject({
      candidateChunkCount: 2,
      findingCount: 1,
    });
  });

  test("blocks approval until critical findings are reviewed", async () => {
    const [run] = await db.select().from(schema.ingestionRuns);
    expect(run).toBeDefined();

    const blocked = await approveReviewRun(db, run!.id, "reviewer@example.com", "Initial review");
    expect(blocked.approved).toBe(false);
    expect(blocked.reasons).toContain("Blocking inspection findings remain open.");

    const [flag] = await db.select().from(schema.chunkFlags);
    await decideChunkFlag(db, flag!.id, {
      status: "accepted",
      reviewer: "reviewer@example.com",
      note: "Known false positive after source comparison.",
    });

    const approved = await approveReviewRun(db, run!.id, "reviewer@example.com", "Approved after review");
    expect(approved.approved).toBe(true);

    const events = await db.select().from(schema.reviewEvents);
    expect(events.map((event) => event.eventType)).toContain("flag_accepted");
    expect(events.map((event) => event.eventType)).toContain("run_approved");
  });

  test("publishes the reviewed vector version and retires the previous one atomically", async () => {
    const [run] = await db.select().from(schema.ingestionRuns);
    const vector = new Array(1024).fill(0);
    const common = {
      embedding: vector,
      text: "Reviewed content",
      chunkIndex: 0,
      totalChunks: 1,
      documentId,
      documentFilename: "SAI-SIF_March-2026.pdf",
      pageNumbers: [1],
      fundName: "SAI SIF",
      amcName: "Mirae Asset",
      schemeType: "",
      schemeCategory: "",
      docType: "SAI",
      documentDate: "2026-03-01",
      hasTable: false,
      sectionHeader: null,
      sebiSchemeId: "",
      sebiUrl: "",
      knowledgeDomain: "sif",
      sourceCollection: "mirae_sif",
      amcSlug: "mirae-asset",
      ...ownership,
    };
    await db.insert(schema.chunks).values([
      { ...common, id: crypto.randomUUID(), publicationStatus: "published" },
      {
        ...common,
        id: crypto.randomUUID(),
        ingestionRunId: run!.id,
        publicationStatus: "staged",
        text: "New reviewed content",
      },
      {
        ...common,
        id: crypto.randomUUID(),
        ingestionRunId: run!.id,
        publicationStatus: "staged",
        chunkIndex: 1,
        text: "Second reviewed chunk",
      },
    ]);

    await updateReviewRunStatus(
      db,
      run!.id,
      "approved",
      "staged",
      "publisher@example.com",
    );
    await publishReviewRun(db, run!.id, "publisher@example.com");

    const stored = await db.select().from(schema.chunks);
    expect(stored.find((chunk) => chunk.ingestionRunId === run!.id)?.publicationStatus).toBe("published");
    expect(stored.find((chunk) => chunk.ingestionRunId === null)?.publicationStatus).toBe("retired");
    const [publishedRun] = await db.select().from(schema.ingestionRuns);
    expect(publishedRun?.status).toBe("published");
  });
});
