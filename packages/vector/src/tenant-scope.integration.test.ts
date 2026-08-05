import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAuthorizedTenantAccessScope,
  createTenantAccessScope,
  type TenantAccessScope,
} from "@mf-rag/types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const tenantA = createTenantAccessScope("tenant-a");
const tenantB = createTenantAccessScope("tenant-b");
const rta = createAuthorizedTenantAccessScope("RTA");

integrationDescribe("tenant-scoped vector retrieval", () => {
  let packageClient: typeof import("@mf-rag/db/client")["client"];
  let pdfDocumentId = "";
  let htmlDocumentId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { client, db } = await import("@mf-rag/db/client");
    const {
      chunks,
      documents,
      htmlChunks,
      htmlDocuments,
    } = await import("@mf-rag/db/schema");
    packageClient = client;
    await db.delete(htmlChunks);
    await db.delete(chunks);
    await db.delete(htmlDocuments);
    await db.delete(documents);

    const [pdfDocument] = await db.insert(documents).values({
      filename: "tenant-scope.pdf",
      filepath: "/tmp/tenant-scope.pdf",
      fileHash: "7".repeat(64),
      status: "completed",
    }).returning();
    const [htmlDocument] = await db.insert(htmlDocuments).values({
      title: "Tenant scope",
      sourceUrl: "https://example.test/tenant-scope",
      sourceSlug: "tenant-scope",
      filePath: "/tmp/tenant-scope.html",
      fileHash: "8".repeat(64),
      contentCategory: "education",
      source: "test",
      status: "completed",
      scrapedAt: new Date("2026-07-30T00:00:00Z"),
    }).returning();
    pdfDocumentId = pdfDocument!.id;
    htmlDocumentId = htmlDocument!.id;

    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const ownership = [
      {
        label: "global",
        visibility_scope: "GLOBAL" as const,
        tenant_id: null,
        ownership_manifest_id: "scope-fixture",
        ownership_manifest_version: 1,
      },
      {
        label: "tenant-a",
        visibility_scope: "TENANT" as const,
        tenant_id: "tenant-a",
        ownership_manifest_id: "scope-fixture",
        ownership_manifest_version: 1,
      },
      {
        label: "tenant-b",
        visibility_scope: "TENANT" as const,
        tenant_id: "tenant-b",
        ownership_manifest_id: "scope-fixture",
        ownership_manifest_version: 1,
      },
      {
        label: "unclassified",
        visibility_scope: "UNCLASSIFIED" as const,
        tenant_id: null,
        ownership_manifest_id: null,
        ownership_manifest_version: null,
      },
    ];

    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    await vectorClient.upsertChunks(ownership.flatMap((owner, index) => [
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          text: `scope proof ${owner.label}`,
          chunk_index: index,
          total_chunks: ownership.length + 2,
          document_id: pdfDocumentId,
          document_filename: "tenant-scope.pdf",
          page_numbers: [index + 1],
          fund_name: owner.label === "tenant-a"
            ? "Alpha Exclusive"
            : owner.label === "tenant-b"
              ? "Beta Exclusive"
              : owner.label === "global"
                ? "Shared Common"
                : "",
          amc_name: owner.label,
          scheme_type: "",
          scheme_category: "",
          doc_type: "SID",
          document_date: "2026-07-30",
          has_table: false,
          section_header: null,
          sebi_scheme_id: "",
          sebi_url: "",
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          ...owner,
        },
      },
    ]));
    await vectorClient.upsertChunks([
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          text: "scope proof staged tenant-a",
          chunk_index: 4,
          total_chunks: 6,
          document_id: pdfDocumentId,
          document_filename: "tenant-scope.pdf",
          page_numbers: [5],
          fund_name: "Staged Fund",
          amc_name: "",
          scheme_type: "",
          scheme_category: "",
          doc_type: "SID",
          document_date: "2026-07-30",
          has_table: false,
          section_header: null,
          sebi_scheme_id: "",
          sebi_url: "",
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          publication_status: "staged",
          visibility_scope: "TENANT",
          tenant_id: "tenant-a",
          ownership_manifest_id: "scope-fixture",
          ownership_manifest_version: 1,
        },
      },
      {
        id: crypto.randomUUID(),
        vector,
        payload: {
          text: "scope proof retired tenant-b",
          chunk_index: 5,
          total_chunks: 6,
          document_id: pdfDocumentId,
          document_filename: "tenant-scope.pdf",
          page_numbers: [6],
          fund_name: "Retired Fund",
          amc_name: "",
          scheme_type: "",
          scheme_category: "",
          doc_type: "SID",
          document_date: "2026-07-30",
          has_table: false,
          section_header: null,
          sebi_scheme_id: "",
          sebi_url: "",
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          publication_status: "retired",
          visibility_scope: "TENANT",
          tenant_id: "tenant-b",
          ownership_manifest_id: "scope-fixture",
          ownership_manifest_version: 1,
        },
      },
    ]);
    await vectorClient.upsertHtmlChunks([
      ...ownership.map((owner, index) => ({
        id: crypto.randomUUID(),
        vector,
        payload: {
          text: `scope proof html ${owner.label}`,
          chunk_index: index,
          total_chunks: ownership.length + 2,
          document_id: htmlDocumentId,
          document_title: owner.label,
          source_url: `https://example.test/${owner.label}`,
          content_category: "education",
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          section_heading: null,
          has_table: false,
          ...owner,
        },
      })),
      ...(["staged", "retired"] as const).map((publicationStatus, index) => ({
        id: crypto.randomUUID(),
        vector,
        payload: {
          text: `scope proof html ${publicationStatus} tenant-${index === 0 ? "a" : "b"}`,
          chunk_index: ownership.length + index,
          total_chunks: ownership.length + 2,
          document_id: htmlDocumentId,
          document_title: `${publicationStatus} tenant`,
          source_url: `https://example.test/${publicationStatus}`,
          content_category: "education",
          knowledge_domain: "sif",
          source_collection: "mirae_sif",
          section_heading: null,
          has_table: false,
          publication_status: publicationStatus,
          visibility_scope: "TENANT" as const,
          tenant_id: index === 0 ? "tenant-a" : "tenant-b",
          ownership_manifest_id: "scope-fixture",
          ownership_manifest_version: 1,
        },
      })),
    ]);
  });

  afterAll(async () => {
    await packageClient.close();
  });

  test.each([
    ["tenant-a", tenantA, ["global", "tenant-a"]],
    ["tenant-b", tenantB, ["global", "tenant-b"]],
    ["RTA", rta, ["global", "tenant-a", "tenant-b"]],
  ])("returns GLOBAL plus %s across dense and lexical PDF/HTML paths", async (
    _label,
    accessScope,
    expected,
  ) => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const [pdfDense, pdfLexical, htmlDense, htmlLexical] = await Promise.all([
      vectorClient.searchSimilar(vector, { accessScope, limit: 20 }),
      vectorClient.searchLexical("scope proof", { accessScope, limit: 20 }),
      vectorClient.searchHtmlSimilar(vector, { accessScope, limit: 20 }),
      vectorClient.searchHtmlLexical("scope proof", { accessScope, limit: 20 }),
    ]);

    expect(pdfDense.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expected);
    expect(pdfLexical.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expected);
    expect(htmlDense.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expected);
    expect(htmlLexical.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expected);
    for (const row of [pdfDense, pdfLexical, htmlDense, htmlLexical].flat()) {
      expect(row.payload.text).not.toMatch(/staged|retired|unclassified/);
    }
  });

  test("applies the same scope to listing, counts, and direct citation lookup", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const schemes = await vectorClient.getUniqueFundNames(tenantA);
    const pdfInfo = await vectorClient.getCollectionInfo(tenantA);
    const htmlInfo = await vectorClient.getHtmlCollectionInfo(tenantA);
    const rtaSchemes = await vectorClient.getUniqueFundNames(rta);
    const rtaPdfInfo = await vectorClient.getCollectionInfo(rta);
    const rtaHtmlInfo = await vectorClient.getHtmlCollectionInfo(rta);
    const otherTenantCitation = await vectorClient.searchSimilar(vector, {
      accessScope: tenantA,
      filters: { document_id: pdfDocumentId, amc_name: "tenant-b" },
      limit: 10,
    });
    const rtaOtherTenantCitation = await vectorClient.searchSimilar(vector, {
      accessScope: rta,
      filters: { document_id: pdfDocumentId, amc_name: "tenant-b" },
      limit: 10,
    });

    expect(schemes).toEqual(["Alpha Exclusive", "Shared Common"]);
    expect(pdfInfo.points_count).toBe(2);
    expect(htmlInfo.points_count).toBe(2);
    expect(otherTenantCitation).toEqual([]);
    expect(rtaSchemes).toEqual([
      "Alpha Exclusive",
      "Beta Exclusive",
      "Shared Common",
    ]);
    expect(rtaPdfInfo.points_count).toBe(3);
    expect(rtaHtmlInfo.points_count).toBe(3);
    expect(rtaOtherTenantCitation).toHaveLength(1);
    expect(rtaOtherTenantCitation[0]?.payload.amc_name).toBe("tenant-b");
  });

  test.each([
    ["tenant-a", tenantA],
    ["tenant-b", tenantB],
    ["RTA", rta],
  ])("approximate dense search matches exact filtered recall for %s", async (
    _label,
    accessScope,
  ) => {
    const { VectorClient } = await import("./pgvector.ts");
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const vectorValue = `[${vector.join(",")}]`;
    const exact = await packageClient.begin(async (transaction) => {
      await transaction`SET LOCAL enable_indexscan = off`;
      await transaction`SET LOCAL enable_bitmapscan = off`;
      return transaction`
        SELECT id
        FROM chunks
        WHERE publication_status = 'published'
          AND CASE
            WHEN ${accessScope.kind} = 'all-tenants'
              THEN visibility_scope IN ('GLOBAL', 'TENANT')
            ELSE (
              visibility_scope = 'GLOBAL'
              OR (
                visibility_scope = 'TENANT'
                AND tenant_id = ${accessScope.tenantId}
              )
            )
          END
        ORDER BY embedding <=> ${vectorValue}::vector, id
        LIMIT 20
      `;
    }) as Array<{ id: string }>;
    const approximate = await new VectorClient().searchSimilar(vector, {
      accessScope,
      limit: 20,
    });
    const exactIds = new Set(exact.map((row) => row.id));
    const returnedExact = approximate.filter((row) => exactIds.has(row.id)).length;

    expect(returnedExact / exactIds.size).toBe(1);
    expect(new Set(approximate.map((row) => row.id))).toEqual(exactIds);
  });

  test("rejects an empty repository access context", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    await expect(new VectorClient().searchLexical("scope proof", {
      accessScope: { tenantId: "" } as unknown as TenantAccessScope,
    })).rejects.toThrow("Tenant access scope is required");
  });
});
