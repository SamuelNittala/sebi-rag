import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTenantAccessScope } from "@mf-rag/types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const accessScope = createTenantAccessScope("tenant-test");

integrationDescribe("vector publication isolation", () => {
  let packageClient: typeof import("@mf-rag/db/client")["client"];
  let documentId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { client, db } = await import("@mf-rag/db/client");
    const { chunks, documents } = await import("@mf-rag/db/schema");
    packageClient = client;
    await db.delete(chunks);
    await db.delete(documents);
    const [document] = await db.insert(documents).values({
      filename: "publication-filter.pdf",
      filepath: "/tmp/publication-filter.pdf",
      fileHash: "f".repeat(64),
      status: "completed",
    }).returning();
    documentId = document!.id;
  });

  afterAll(async () => {
    await packageClient.close();
  });

  test("retrieval excludes staged and retired chunk versions", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const basePayload = {
      chunk_index: 0,
      total_chunks: 1,
      document_id: documentId,
      document_filename: "publication-filter.pdf",
      page_numbers: [1],
      fund_name: "Platinum SIF",
      amc_name: "Mirae Asset",
      scheme_type: "",
      scheme_category: "",
      doc_type: "ISID",
      document_date: "2026-03-01",
      has_table: false,
      section_header: null,
      sebi_scheme_id: "",
      sebi_url: "",
      knowledge_domain: "sif" as const,
      source_collection: "mirae_sif" as const,
      amc_slug: "mirae-asset",
      visibility_scope: "GLOBAL" as const,
      tenant_id: null,
      ownership_manifest_id: "publication-filter-fixture",
      ownership_manifest_version: 1,
    };
    const stagedVector = new Array(1024).fill(0);
    stagedVector[0] = 1;
    const publishedVector = new Array(1024).fill(0);
    publishedVector[1] = 1;

    await vectorClient.upsertChunks([
      {
        id: crypto.randomUUID(),
        vector: stagedVector,
        payload: {
          ...basePayload,
          text: "staged exact match",
          ingestion_run_id: crypto.randomUUID(),
          publication_status: "staged",
        },
      },
      {
        id: crypto.randomUUID(),
        vector: publishedVector,
        payload: {
          ...basePayload,
          text: "currently published",
          publication_status: "published",
        },
      },
      {
        id: crypto.randomUUID(),
        vector: stagedVector,
        payload: {
          ...basePayload,
          text: "retired exact match",
          publication_status: "retired",
        },
      },
    ]);

    const results = await vectorClient.searchSimilar(stagedVector, {
      accessScope,
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.payload.text).toBe("currently published");
  });
});
