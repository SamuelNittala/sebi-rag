import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Database } from "@mf-rag/db/client";

import type { Embedder } from "../embedding/embedder.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("approved review publisher", () => {
  const sql = new SQL(testDatabaseUrl!);
  let database: Database;
  let packageClient: SQL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const dbModule = await import("@mf-rag/db");
    database = dbModule.db;
    packageClient = dbModule.client;
    await sql.unsafe(`TRUNCATE review_events, chunk_flags, chunk_candidates,
      ingestion_runs, chunks, documents CASCADE`);
  });

  afterAll(async () => {
    await packageClient.close();
    await sql.close();
  });

  test("embeds approved candidates, stages them, then publishes the full version", async () => {
    const [document] = await sql`
      INSERT INTO documents (filename, filepath, file_hash, status)
      VALUES (
        'Platinum-SIF-ISID.pdf', '/tmp/Platinum-SIF-ISID.pdf',
        ${"d".repeat(64)}, 'review_required'
      ) RETURNING id
    `;
    const candidateId = crypto.randomUUID();
    const { approveReviewRun, stageInspectionReview } = await import("@mf-rag/db");
    const run = await stageInspectionReview(database, {
      sourceType: "pdf",
      sourceDocumentId: document!.id as string,
      sourceName: "Platinum-SIF-ISID.pdf",
      sourceLocation: "/tmp/Platinum-SIF-ISID.pdf",
      fileHash: "d".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "semantic-v1",
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
        text: "E. WHO MANAGES THE INVESTMENT STRATEGY? Mr. Gaurik Shah",
        pageNumbers: [22],
        tokenCount: 12,
        hasTable: false,
        sectionHeader: "E. WHO MANAGES THE INVESTMENT STRATEGY?",
        metadata: {
          documentScope: "strategy",
          strategyId: "platinum-sif",
          sectionType: "strategy_management",
          factType: "fund_manager",
          sourceCollection: "mirae_sif",
          fundName: "Platinum SIF",
          documentType: "ISID",
          amcName: "Mirae Asset",
          knowledgeDomain: "sif",
          amcSlug: "mirae-asset",
          documentDate: "2026-03-01",
          effectiveDate: "2026-07-01",
          amendmentNumber: "SIF/05/2026",
        },
        contentHash: "e".repeat(64),
      }],
    });
    await approveReviewRun(database, run.id, "reviewer@example.com", "Verified");

    const embeddedTexts: string[] = [];
    const embedder: Embedder = {
      embed: async () => new Array(1024).fill(0),
      embedBatch: async (inputs) => inputs.map((input) => {
        embeddedTexts.push(input.text);
        return {
          chunkIndex: input.chunkIndex,
          embedding: new Array(1024).fill(0),
          tokenCount: 12,
        };
      }),
    };
    const { publishApprovedReviewRun } = await import("./review-publisher.ts");
    const published = await publishApprovedReviewRun(run.id, {
      actor: "publisher@example.com",
      database,
      embedder,
    });

    expect(published.status).toBe("published");
    expect(embeddedTexts[0]).toContain("Fund: Platinum SIF");
    expect(embeddedTexts[0]).toContain("Content type: document text");
    const [stored] = await sql`
      select publication_status, ingestion_run_id, text, page_numbers, retrieval_metadata,
        jsonb_typeof(page_numbers) as page_numbers_type
      from chunks limit 1
    `;
    expect(stored?.publication_status).toBe("published");
    expect(stored?.ingestion_run_id).toBe(run.id);
    expect(stored?.text).toContain("Mr. Gaurik Shah");
    expect(stored?.page_numbers_type).toBe("array");
    expect(stored?.page_numbers).toEqual([22]);
    expect(stored?.retrieval_metadata).toEqual(expect.objectContaining({
      effectiveDate: "2026-07-01",
      amendmentNumber: "SIF/05/2026",
    }));
    const [updatedDocument] = await sql`select status from documents limit 1`;
    expect(updatedDocument?.status).toBe("completed");
  });
});
