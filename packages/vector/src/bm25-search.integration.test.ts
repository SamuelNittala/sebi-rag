import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("PostgreSQL BM25 retrieval", () => {
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
      filename: "platinum-sif-isid.pdf",
      filepath: "/tmp/platinum-sif-isid.pdf",
      fileHash: "b".repeat(64),
      status: "completed",
    }).returning();
    documentId = document!.id;
  });

  afterAll(async () => {
    await packageClient.close();
  });

  test("ranks exact strategy facts, excludes staged chunks, and returns metadata", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const basePayload = {
      total_chunks: 4,
      document_id: documentId,
      document_filename: "platinum-sif-isid.pdf",
      page_numbers: [22],
      fund_name: "I Platinum Hybrid Long Short Fund",
      amc_name: "Mirae Asset",
      scheme_type: "SIF",
      scheme_category: "",
      doc_type: "ISID",
      document_date: "2026-03-01",
      has_table: false,
      sebi_scheme_id: "3166",
      sebi_url: "https://example.test/platinum-sif",
      knowledge_domain: "sif" as const,
      source_collection: "mirae_sif" as const,
      amc_slug: "mirae-asset",
    };

    await vectorClient.upsertChunks([
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...basePayload,
          text: "Mr. Gaurik Shah is the fund manager for the Platinum SIF investment strategy.",
          chunk_index: 0,
          section_header: "Who manages the investment strategy?",
          retrieval_metadata: {
            documentScope: "strategy",
            strategyId: "platinum-hybrid-long-short-fund",
            factType: "fund_manager",
            sourceAuthority: "regulatory_filing",
          },
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...basePayload,
          text: "The AMC staff directory lists several managers and dealers.",
          chunk_index: 1,
          section_header: "Fund Manager",
          retrieval_metadata: {
            documentScope: "amc",
            factType: "staff_directory",
            sourceAuthority: "regulatory_filing",
          },
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...basePayload,
          text: "Mr. Staged Person is the Platinum SIF fund manager.",
          chunk_index: 2,
          section_header: "Fund Manager",
          publication_status: "staged",
          retrieval_metadata: {
            documentScope: "strategy",
            strategyId: "platinum-hybrid-long-short-fund",
            factType: "fund_manager",
          },
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...basePayload,
          text: "A non-Mirae document that mentions a fund manager.",
          chunk_index: 3,
          section_header: "Fund Manager",
          knowledge_domain: "mutual_fund",
          source_collection: "default_corpus",
          fund_name: "Unrelated Fund",
        },
      },
    ]);

    const { db } = await import("@mf-rag/db/client");
    const { chunkSearchDocuments } = await import("@mf-rag/db/schema");
    const indexedChunks = await db.select({ id: chunkSearchDocuments.chunkId })
      .from(chunkSearchDocuments);

    const results = await vectorClient.searchLexical(
      "Who is the fund manager for Platinum SIF?",
      {
        limit: 10,
        filters: {
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          amc_slug: "mirae-asset",
        },
      },
    );

    expect(indexedChunks).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.payload.text).toContain("Gaurik Shah");
    expect(results.some((result) => result.payload.text.includes("Staged Person"))).toBe(false);
    expect(results[0]?.payload.retrieval_metadata?.factType).toBe("fund_manager");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("matches a fund filter across casing, punctuation, and indexed prefixes", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const results = await new VectorClient().searchLexical(
      "Platinum investment strategy",
      {
        limit: 10,
        filters: {
          fund_name: "Platinum Hybrid Long-Short Fund",
          source_collection: "mirae_sif",
        },
      },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) =>
      result.payload.fund_name === "I Platinum Hybrid Long Short Fund"
    )).toBe(true);
  });
});
