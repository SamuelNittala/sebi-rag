import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTenantAccessScope } from "@mf-rag/types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const accessScope = createTenantAccessScope("tenant-test");

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
      visibility_scope: "GLOBAL" as const,
      tenant_id: null,
      ownership_manifest_id: "bm25-fixture",
      ownership_manifest_version: 1,
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
        accessScope,
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
        accessScope,
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

  test("indexes only published classified FAQ chunks and keeps tenant scope", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const faqPayload = {
      text: "Nomination makes mutual fund transmission easier for investors.",
      total_chunks: 4,
      document_id: documentId,
      document_filename: "faq.pdf",
      page_numbers: [4],
      fund_name: null,
      amc_name: null,
      scheme_type: null,
      scheme_category: null,
      doc_type: "FAQ",
      document_date: "2024-09-25",
      has_table: false,
      section_header: "Nomination",
      sebi_scheme_id: null,
      sebi_url: null,
      document_kind: "FAQ",
      document_title: "FAQs for Mutual Fund Investors",
      publisher: "SEBI",
      source_url: "https://example.test/faq.pdf",
      source_date: "2024-09-25",
      authority: "regulator",
      topic: "Nomination",
      original_question: "Why should I register a nominee?",
      normalized_question_key: "why should i register a nominee",
      continuation_index: 0,
      knowledge_domain: "mutual_fund" as const,
      source_collection: "general_mf_faq" as const,
      ownership_manifest_id: "faq-bm25-fixture",
      ownership_manifest_version: 1,
    };
    const globalId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    await vectorClient.upsertChunks([
      {
        id: globalId,
        vector,
        payload: {
          ...faqPayload,
          chunk_index: 10,
          visibility_scope: "GLOBAL",
          tenant_id: null,
        },
      },
      {
        id: tenantId,
        vector,
        payload: {
          ...faqPayload,
          text: "Tenant A nomination process.",
          chunk_index: 11,
          visibility_scope: "TENANT",
          tenant_id: "tenant-test",
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...faqPayload,
          text: "Tenant B nomination process.",
          chunk_index: 12,
          visibility_scope: "TENANT",
          tenant_id: "tenant-other",
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          ...faqPayload,
          text: "Staged nomination process.",
          chunk_index: 13,
          publication_status: "staged",
          visibility_scope: "GLOBAL",
          tenant_id: null,
        },
      },
    ]);

    const results = await vectorClient.searchLexical("nomination transmission", {
      accessScope,
      limit: 10,
      filters: {
        knowledge_domain: "mutual_fund",
        source_collection: "general_mf_faq",
      },
    });

    expect(results.map((result) => result.payload.text).sort()).toEqual([
      "Nomination makes mutual fund transmission easier for investors.",
      "Tenant A nomination process.",
    ]);

    const assertFaqParity = async () => {
      const [denseRows, lexicalRows] = await Promise.all([
        packageClient`
          SELECT id
          FROM chunks
          WHERE publication_status = 'published'
            AND knowledge_domain = 'mutual_fund'
            AND source_collection = 'general_mf_faq'
            AND ownership_manifest_id IS NOT NULL
            AND ownership_manifest_version > 0
            AND (
              (visibility_scope = 'GLOBAL' AND tenant_id IS NULL)
              OR (visibility_scope = 'TENANT' AND tenant_id IS NOT NULL)
            )
          ORDER BY id
        ` as Promise<Array<{ id: string }>>,
        packageClient`
          SELECT search.chunk_id AS id
          FROM chunk_search_documents search
          JOIN chunks ON chunks.id = search.chunk_id
          WHERE chunks.knowledge_domain = 'mutual_fund'
            AND chunks.source_collection = 'general_mf_faq'
          ORDER BY search.chunk_id
        ` as Promise<Array<{ id: string }>>,
      ]);
      expect(lexicalRows.map((row) => row.id)).toEqual(denseRows.map((row) => row.id));
    };

    await assertFaqParity();

    await packageClient`
      UPDATE chunks
      SET original_question = 'How is a folio nominee registered?'
      WHERE id = ${globalId}
    `;
    const edited = await vectorClient.searchLexical("folio nominee registered", {
      accessScope,
      filters: {
        knowledge_domain: "mutual_fund",
        source_collection: "general_mf_faq",
      },
    });
    expect(edited.some((result) => result.id === globalId)).toBe(true);
    await assertFaqParity();

    await packageClient`
      UPDATE chunks
      SET tenant_id = 'tenant-other'
      WHERE id = ${tenantId}
    `;
    const reclassified = await vectorClient.searchLexical("tenant nomination process", {
      accessScope,
      filters: {
        knowledge_domain: "mutual_fund",
        source_collection: "general_mf_faq",
      },
    });
    expect(reclassified.some((result) => result.id === tenantId)).toBe(false);
    await assertFaqParity();

    await expect(packageClient.begin(async (transaction) => {
      await transaction`
        UPDATE chunks
        SET publication_status = 'retired'
        WHERE id = ${globalId}
      `;
      throw new Error("injected publication failure");
    })).rejects.toThrow("injected publication failure");
    await assertFaqParity();
    expect((await vectorClient.searchLexical("folio nominee registered", {
      accessScope,
      filters: {
        knowledge_domain: "mutual_fund",
        source_collection: "general_mf_faq",
      },
    })).some((result) => result.id === globalId)).toBe(true);

    await packageClient`
      UPDATE chunks
      SET publication_status = 'retired'
      WHERE id = ${globalId}
    `;
    await assertFaqParity();
    expect((await vectorClient.searchLexical("folio nominee registered", {
      accessScope,
      filters: {
        knowledge_domain: "mutual_fund",
        source_collection: "general_mf_faq",
      },
    })).some((result) => result.id === globalId)).toBe(false);
  });
});
