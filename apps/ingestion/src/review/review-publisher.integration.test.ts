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
  const globalOwnership = {
    visibilityScope: "GLOBAL" as const,
    tenantId: null,
    ownershipManifestId: "publisher-test-manifest",
    ownershipManifestVersion: 1,
  };

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
      INSERT INTO documents (
        filename, filepath, file_hash, status, visibility_scope, tenant_id,
        ownership_manifest_id, ownership_manifest_version
      )
      VALUES (
        'Platinum-SIF-ISID.pdf', '/tmp/Platinum-SIF-ISID.pdf',
        ${"d".repeat(64)}, 'review_required', ${globalOwnership.visibilityScope},
        ${globalOwnership.tenantId}, ${globalOwnership.ownershipManifestId},
        ${globalOwnership.ownershipManifestVersion}
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
      ownership: globalOwnership,
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
    const unpublished = await sql`
      select count(*)::int as count from chunks where ingestion_run_id = ${run.id}::uuid
    `;
    expect(unpublished[0]?.count).toBe(0);
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
      select publication_status, ingestion_run_id, text, page_numbers,
        case
          when jsonb_typeof(retrieval_metadata) = 'string'
            then (retrieval_metadata #>> '{}')::jsonb
          else retrieval_metadata
        end as retrieval_metadata,
        visibility_scope, tenant_id, ownership_manifest_id, ownership_manifest_version,
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
    expect(stored).toEqual(expect.objectContaining({
      visibility_scope: "GLOBAL",
      tenant_id: null,
      ownership_manifest_id: globalOwnership.ownershipManifestId,
      ownership_manifest_version: globalOwnership.ownershipManifestVersion,
    }));
    const [lexical] = await sql`
      select count(*)::int as count
      from chunk_search_documents search
      join chunks chunk on chunk.id = search.chunk_id
      where chunk.ingestion_run_id = ${run.id}::uuid
    `;
    expect(lexical?.count).toBe(1);
    const [updatedDocument] = await sql`select status from documents limit 1`;
    expect(updatedDocument?.status).toBe("completed");
  });

  test("rejects candidate ownership mutation before embedding or published visibility", async () => {
    const tenantOwnership = {
      visibilityScope: "TENANT" as const,
      tenantId: "tenant-b",
      ownershipManifestId: "publisher-test-manifest",
      ownershipManifestVersion: 2,
    };
    const [document] = await sql`
      INSERT INTO documents (
        filename, filepath, file_hash, status, visibility_scope, tenant_id,
        ownership_manifest_id, ownership_manifest_version
      )
      VALUES (
        'tenant-b.pdf', '/tmp/tenant-b.pdf', ${"f".repeat(64)}, 'review_required',
        ${tenantOwnership.visibilityScope}, ${tenantOwnership.tenantId},
        ${tenantOwnership.ownershipManifestId}, ${tenantOwnership.ownershipManifestVersion}
      ) RETURNING id
    `;
    const { approveReviewRun, stageInspectionReview } = await import("@mf-rag/db");
    const run = await stageInspectionReview(database, {
      sourceType: "pdf",
      sourceDocumentId: document!.id as string,
      sourceName: "tenant-b.pdf",
      sourceLocation: "/tmp/tenant-b.pdf",
      fileHash: "f".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "semantic-v1",
      ownership: tenantOwnership,
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
        id: crypto.randomUUID(),
        chunkIndex: 0,
        text: "Tenant B reviewed content",
        pageNumbers: [1],
        tokenCount: 5,
        hasTable: false,
        sectionHeader: null,
        metadata: {
          documentScope: "amc",
          fundName: "Tenant B Fund",
          documentType: "Factsheet",
          knowledgeDomain: "mutual_fund",
          sourceCollection: "default_corpus",
        },
        contentHash: "a".repeat(64),
      }],
    });
    await approveReviewRun(database, run.id, "reviewer@example.com", "Verified");
    await sql`
      update chunk_candidates
      set visibility_scope = 'TENANT',
        tenant_id = 'tenant-a',
        ownership_manifest_id = 'publisher-test-manifest',
        ownership_manifest_version = 2
      where ingestion_run_id = ${run.id}::uuid
    `;

    let embeddingCalls = 0;
    const embedder: Embedder = {
      embed: async () => new Array(1024).fill(0),
      embedBatch: async () => {
        embeddingCalls += 1;
        return [];
      },
    };
    const { publishApprovedReviewRun } = await import("./review-publisher.ts");
    await expect(publishApprovedReviewRun(run.id, {
      actor: "publisher@example.com",
      authorizedTenantId: "tenant-b",
      database,
      embedder,
    })).rejects.toThrow("ownership");

    expect(embeddingCalls).toBe(0);
    const [visible] = await sql`
      select count(*)::int as count
      from chunks
      where ingestion_run_id = ${run.id}::uuid
        and publication_status = 'published'
    `;
    expect(visible?.count).toBe(0);
  });
});
