import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("pre-embedding review gate", () => {
  const sql = new SQL(testDatabaseUrl!);
  let existingFilePath = "";
  let existingDocumentId = "";
  const ownership = {
    visibilityScope: "GLOBAL" as const,
    tenantId: null,
    ownershipManifestId: "review-gate-test",
    ownershipManifestVersion: 1,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    await sql.unsafe(`
      TRUNCATE review_events, chunk_flags, chunk_candidates, ingestion_runs,
        html_chunks, html_documents CASCADE
    `);
  });

  afterAll(async () => {
    await sql.close();
  });

  test("stages and inspects HTML chunks without calling the embedder", async () => {
    const filePath = `/tmp/review-gate-${Date.now()}.md`;
    existingFilePath = filePath;
    await Bun.write(filePath, `---
title: "Review Gate Test Fund"
source_url: "https://example.com/review-gate-test"
content_category: product
source: mirae-sif
scraped_at: "2026-07-16T00:00:00.000Z"
---

# Review Gate Test Fund

Product overview content that must be inspected before it can be embedded.

## Fund Manager

The investment strategy is managed by the person named in the source document.
`);

    const { ingestHtmlDocument } = await import("./ingest-html.ts");
    const result = await ingestHtmlDocument(filePath, {
      ollamaUrl: "http://127.0.0.1:1",
      ownership,
    });

    expect(result.status).toBe("review_required");
    expect(result.reviewRunId).toBeDefined();
    existingDocumentId = result.documentId;

    const runs = await sql`select status, candidate_chunk_count, inspected_chunk_count from ingestion_runs`;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.objectContaining({
      status: "review_ready",
      candidate_chunk_count: runs[0]?.inspected_chunk_count,
    }));

    const vectorCount = await sql`select count(*)::int as count from html_chunks`;
    expect(vectorCount[0]?.count).toBe(0);
  });

  test("reinspects an existing document without removing its published vectors", async () => {
    const vector = `[${new Array(1024).fill(0).join(",")}]`;
    await sql.unsafe(`
      INSERT INTO html_chunks (
        embedding, text, chunk_index, total_chunks, document_id, document_title,
        source_url, content_category, section_heading, has_table, publication_status
        , visibility_scope, ownership_manifest_id, ownership_manifest_version
      ) VALUES (
        '${vector}'::vector, 'Previously published content', 0, 1,
        '${existingDocumentId}'::uuid, 'Review Gate Test Fund',
        'https://example.com/review-gate-test', 'product', null, false, 'published',
        'GLOBAL', 'review-gate-test', 1
      )
    `);

    const { ingestHtmlDocument } = await import("./ingest-html.ts");
    const result = await ingestHtmlDocument(existingFilePath, {
      ollamaUrl: "http://127.0.0.1:1",
      reviewExisting: true,
      ownership,
    });

    expect(result.status).toBe("review_required");
    expect(result.documentId).toBe(existingDocumentId);
    const published = await sql`
      select text, publication_status from html_chunks
      where document_id = ${existingDocumentId}::uuid
    `;
    expect(published).toEqual([expect.objectContaining({
      text: "Previously published content",
      publication_status: "published",
    })]);
  });

  test("stages a changed same-URL rescrape against the existing source version", async () => {
    await Bun.write(existingFilePath, `---
title: "Review Gate Test Fund Updated"
source_url: "https://example.com/review-gate-test"
content_category: education
source: mirae-sif
scraped_at: "2026-07-17T00:00:00.000Z"
---

# Review Gate Test Fund Updated

Updated content must create a new review run without replacing published vectors.
`);

    const { ingestHtmlDocument } = await import("./ingest-html.ts");
    const result = await ingestHtmlDocument(existingFilePath, { ownership });

    expect(result).toEqual(expect.objectContaining({
      status: "review_required",
      documentId: existingDocumentId,
      title: "Review Gate Test Fund Updated",
    }));

    const [document] = await sql`
      select title, content_category, file_hash, scraped_at
      from html_documents where id = ${existingDocumentId}::uuid
    `;
    expect(document).toEqual(expect.objectContaining({
      title: "Review Gate Test Fund Updated",
      content_category: "education",
      scraped_at: new Date("2026-07-17T00:00:00.000Z"),
    }));
    expect(document?.file_hash).not.toBeNull();

    const runs = await sql`
      select file_hash from ingestion_runs where source_document_id = ${existingDocumentId}::uuid
    `;
    expect(runs).toHaveLength(3);
    expect(runs.some((run: { file_hash: string }) => run.file_hash === document?.file_hash)).toBe(true);
    const published = await sql`
      select text from html_chunks
      where document_id = ${existingDocumentId}::uuid and publication_status = 'published'
    `;
    expect(published).toEqual([expect.objectContaining({ text: "Previously published content" })]);
  });

  test("rejects a same-URL rescrape with changed trusted ownership before staging", async () => {
    const result = await (await import("./ingest-html.ts")).ingestHtmlDocument(existingFilePath, {
      ownership: {
        visibilityScope: "TENANT",
        tenantId: "tenant-a",
        ownershipManifestId: "review-gate-test",
        ownershipManifestVersion: 1,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      status: "failed",
      error: "Trusted ownership does not match the existing HTML source document.",
    }));
    const runs = await sql`
      select id from ingestion_runs where source_document_id = ${existingDocumentId}::uuid
    `;
    expect(runs).toHaveLength(3);
  });
});
