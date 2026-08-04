import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createTenantAccessScope,
  type TenantAccessScope,
} from "@mf-rag/types";
import { and, eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;
const tenantA = createTenantAccessScope("910");
const tenantB = createTenantAccessScope("117");

integrationDescribe("tenant-scoped vector retrieval", () => {
  let packageClient: typeof import("@mf-rag/db/client")["client"];
  let pdfDocumentId = "";
  let htmlDocumentId = "";
  let scheduled117DocumentId = "";
  let scheduledRevisionId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { client, db } = await import("@mf-rag/db/client");
    const {
      chunks,
      accessScopes,
      artifacts,
      documentPublicationChunks,
      documentPublicationGenerations,
      documentVersions,
      documents,
      htmlChunks,
      htmlDocuments,
      ingestionRuns,
      pipelineRuns,
      sourceDocuments,
      sourceRegistryRevisions,
      sources,
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
        label: "910",
        visibility_scope: "TENANT" as const,
        tenant_id: "910",
        ownership_manifest_id: "scope-fixture",
        ownership_manifest_version: 1,
      },
      {
        label: "117",
        visibility_scope: "TENANT" as const,
        tenant_id: "117",
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
          fund_name: owner.label === "910"
            ? "SIF Exclusive"
            : owner.label === "117"
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
          text: "scope proof staged 910",
          chunk_index: 5,
          total_chunks: 6,
          document_id: pdfDocumentId,
          document_filename: "tenant-scope.pdf",
          page_numbers: [6],
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
          tenant_id: "910",
          ownership_manifest_id: "scope-fixture",
          ownership_manifest_version: 1,
        },
      },
    ]);
    await vectorClient.upsertHtmlChunks(ownership.map((owner, index) => ({
      id: crypto.randomUUID(),
      vector,
      payload: {
        text: `scope proof html ${owner.label}`,
        chunk_index: index,
        total_chunks: ownership.length,
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
    })));

    const revisionChecksum = createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const [revision] = await db.insert(sourceRegistryRevisions).values({
      checksum: revisionChecksum,
      desiredState: { version: 1, accessScopes: [] },
      isActive: false,
    }).returning();
    scheduledRevisionId = revision!.id;
    const identicalHash = "e".repeat(64);
    for (const code of ["910", "117"] as const) {
      const [insertedScope] = await db.insert(accessScopes).values({
        accessScopeKey: `retrieval-fixture-${code}`,
        externalCode: code,
        tenantId: code,
        knowledgeDomain: code === "910" ? "sif" : "mutual_fund",
        sourceCollection: code === "910" ? "mirae_sif" : "mirae_mf",
        amcSlug: "mirae-asset",
        configRevisionId: revision!.id,
      }).onConflictDoNothing().returning();
      const [scope] = insertedScope ? [insertedScope] : await db.select().from(accessScopes)
        .where(eq(accessScopes.externalCode, code)).limit(1);
      const [insertedSource] = await db.insert(sources).values({
        accessScopeId: scope!.id,
        sourceKey: "scheduled-retrieval-fixture",
        connector: "website_pdf",
        discoveryConfig: { strategy: "explicit_urls", urls: [] },
        fetchConfig: {
          allowedHosts: ["example.test"], allowedPathPrefixes: ["/"],
          maxBytes: 1024, timeoutMs: 1000, maxRedirects: 0,
        },
        reviewConfig: { policy: "risk_based" },
        configRevisionId: scope!.configRevisionId,
      }).onConflictDoNothing().returning();
      const [source] = insertedSource ? [insertedSource] : await db.select().from(sources)
        .where(and(
          eq(sources.accessScopeId, scope!.id),
          eq(sources.sourceKey, "scheduled-retrieval-fixture"),
        )).limit(1);
      const [artifact] = await db.insert(artifacts).values({
        artifactKey: `scope-fixture/${code}/${identicalHash}`,
        uri: `s3://scope-fixture/${code}/${identicalHash}`,
        sha256: identicalHash,
        byteSize: 100,
        mediaType: "application/pdf",
        producerVersion: "fixture-v1",
        verifiedAt: new Date(),
      }).onConflictDoUpdate({
        target: artifacts.artifactKey,
        set: { verifiedAt: new Date() },
      }).returning();
      const [document] = await db.insert(sourceDocuments).values({
        accessScopeId: scope!.id,
        sourceId: source!.id,
        logicalDocumentKey: `identical-bytes-${code}.pdf`,
        canonicalUrl: `https://example.test/${code}/identical.pdf`,
      }).onConflictDoUpdate({
        target: [sourceDocuments.sourceId, sourceDocuments.logicalDocumentKey],
        set: { updatedAt: new Date() },
      }).returning();
      const [version] = await db.insert(documentVersions).values({
        sourceDocumentId: document!.id,
        accessScopeId: scope!.id,
        sourceId: source!.id,
        sequence: 1,
        contentSha256: identicalHash,
        rawArtifactId: artifact!.id,
        configRevisionId: scope!.configRevisionId,
        readyAt: new Date(),
      }).onConflictDoUpdate({
        target: [documentVersions.sourceDocumentId, documentVersions.contentSha256],
        set: { observedAt: new Date() },
      }).returning();
      await db.update(sourceDocuments).set({ currentVersionId: version!.id })
        .where(eq(sourceDocuments.id, document!.id));
      const [pipeline] = await db.insert(pipelineRuns).values({
        documentVersionId: version!.id,
        accessScopeId: scope!.id,
        sourceId: source!.id,
        implementationVersion: "scope-fixture-v1",
        configRevisionId: scope!.configRevisionId,
        initialStage: "PARSE",
        initialStageImplementationVersion: "parse-fixture-v1",
        initialInputChecksum: identicalHash,
        initialMaxAttempts: 3,
        status: "succeeded",
      }).onConflictDoUpdate({
        target: [pipelineRuns.documentVersionId, pipelineRuns.implementationVersion],
        set: { status: "succeeded" },
      }).returning();
      const [insertedRun] = await db.insert(ingestionRuns).values({
        sourceType: "pdf",
        sourceDocumentId: document!.id,
        sourceName: `scheduled-${code}.pdf`,
        fileHash: identicalHash,
        parserVersion: "parse-fixture-v1",
        chunkerVersion: "chunk-fixture-v1",
        inspectorVersion: "inspect-fixture-v1",
        status: "published",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        documentVersionId: version!.id,
        pipelineRunId: pipeline!.id,
        configRevisionId: scope!.configRevisionId,
        visibilityScope: "TENANT",
        tenantId: code,
        ownershipManifestId: "scope-fixture",
        ownershipManifestVersion: 1,
      }).onConflictDoNothing().returning();
      const [run] = insertedRun ? [insertedRun] : await db.select().from(ingestionRuns)
        .where(eq(ingestionRuns.documentVersionId, version!.id)).limit(1);
      const [generation] = await db.insert(documentPublicationGenerations).values({
        sourceDocumentId: document!.id,
        documentVersionId: version!.id,
        ingestionRunId: run!.id,
        pipelineRunId: pipeline!.id,
        accessScopeId: scope!.id,
        sourceId: source!.id,
        configRevisionId: scope!.configRevisionId,
        riskPolicyVersion: "fixture-v1",
        riskDecisionActor: "fixture",
        parserVersion: "parse-fixture-v1",
        chunkerVersion: "chunk-fixture-v1",
        inspectorVersion: "inspect-fixture-v1",
        status: "published",
        visibilityScope: "TENANT",
        tenantId: code,
        ownershipManifestId: "scope-fixture",
        ownershipManifestVersion: 1,
        publishedAt: new Date(),
      }).onConflictDoUpdate({
        target: documentPublicationGenerations.ingestionRunId,
        set: { status: "published" },
      }).returning();
      await db.insert(documentPublicationChunks).values({
        generationId: generation!.id,
        embedding: vector,
        text: `scope proof scheduled ${code}`,
        chunkIndex: 0,
        totalChunks: 1,
        pageNumbers: [1],
        sectionHeader: null,
        hasTable: false,
        retrievalMetadata: {
          documentScope: "unknown",
          fundName: `Scheduled ${code}`,
          documentType: "SID",
          documentKind: "generic_pdf",
          sourceCollection: code === "910" ? "mirae_sif" : "mirae_mf",
        },
        visibilityScope: "TENANT",
        tenantId: code,
        ownershipManifestId: "scope-fixture",
        ownershipManifestVersion: 1,
      }).onConflictDoNothing();
      if (code === "117") scheduled117DocumentId = document!.id;
    }
    await packageClient`
      UPDATE document_publication_chunks
      SET retrieval_metadata = (retrieval_metadata #>> '{}')::jsonb
      WHERE jsonb_typeof(retrieval_metadata) = 'string'
    `;
  });

  afterAll(async () => {
    await packageClient`
      DELETE FROM document_publication_chunks
      WHERE generation_id IN (
        SELECT id FROM document_publication_generations
        WHERE risk_policy_version = 'fixture-v1' AND risk_decision_actor = 'fixture'
      )
    `;
    await packageClient`
      DELETE FROM document_publication_generations
      WHERE risk_policy_version = 'fixture-v1' AND risk_decision_actor = 'fixture'
    `;
    await packageClient`DELETE FROM ingestion_runs WHERE source_name LIKE 'scheduled-%.pdf'`;
    await packageClient`DELETE FROM pipeline_runs WHERE implementation_version = 'scope-fixture-v1'`;
    await packageClient`
      UPDATE source_documents SET current_version_id = NULL
      WHERE logical_document_key LIKE 'identical-bytes-%.pdf'
    `;
    await packageClient`
      DELETE FROM document_versions
      WHERE source_document_id IN (
        SELECT id FROM source_documents WHERE logical_document_key LIKE 'identical-bytes-%.pdf'
      )
    `;
    await packageClient`DELETE FROM source_documents WHERE logical_document_key LIKE 'identical-bytes-%.pdf'`;
    await packageClient`DELETE FROM artifacts WHERE artifact_key LIKE 'scope-fixture/%'`;
    await packageClient`DELETE FROM sources WHERE source_key = 'scheduled-retrieval-fixture'`;
    await packageClient`DELETE FROM access_scopes WHERE access_scope_key LIKE 'retrieval-fixture-%'`;
    await packageClient`DELETE FROM source_registry_revisions WHERE id = ${scheduledRevisionId}::uuid`;
    await packageClient.close();
  });

  test.each([
    ["910", tenantA, ["910", "910", "global"], ["910", "global"]],
    ["117", tenantB, ["117", "117", "global"], ["117", "global"]],
  ])("returns GLOBAL plus %s across dense and lexical PDF/HTML paths", async (
    _label,
    accessScope,
    expectedPdf,
    expectedHtml,
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
      .toEqual(expectedPdf);
    expect(pdfLexical.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expectedPdf);
    expect(htmlDense.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expectedHtml);
    expect(htmlLexical.map((row) => row.payload.text.split(" ").at(-1)).sort())
      .toEqual(expectedHtml);
  });

  test("applies the same scope to listing, counts, and direct citation lookup", async () => {
    const { VectorClient } = await import("./pgvector.ts");
    const vectorClient = new VectorClient();
    const vector = new Array(1024).fill(0);
    vector[0] = 1;
    const schemes = await vectorClient.getUniqueFundNames(tenantA);
    const pdfInfo = await vectorClient.getCollectionInfo(tenantA);
    const htmlInfo = await vectorClient.getHtmlCollectionInfo(tenantA);
    const otherTenantCitation = await vectorClient.searchSimilar(vector, {
      accessScope: tenantA,
      filters: { document_id: pdfDocumentId, amc_name: "117" },
      limit: 10,
    });

    expect(schemes).toEqual(["Scheduled 910", "Shared Common", "SIF Exclusive"]);
    expect(pdfInfo.points_count).toBe(3);
    expect(htmlInfo.points_count).toBe(2);
    expect(otherTenantCitation).toEqual([]);
    expect(await vectorClient.searchSimilar(vector, {
      accessScope: tenantA,
      filters: { document_id: scheduled117DocumentId },
      limit: 10,
    })).toEqual([]);
  });

  test.each([
    ["910", tenantA],
    ["117", tenantB],
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
        FROM (
          SELECT id, embedding, visibility_scope, tenant_id
          FROM chunks
          WHERE publication_status = 'published'
          UNION ALL
          SELECT chunk.id, chunk.embedding, chunk.visibility_scope, chunk.tenant_id
          FROM document_publication_chunks chunk
          JOIN document_publication_generations generation
            ON generation.id = chunk.generation_id
          WHERE generation.status = 'published'
        ) published
        WHERE (
            visibility_scope = 'GLOBAL'
            OR (
              visibility_scope = 'TENANT'
              AND tenant_id = ${accessScope.tenantId}
            )
          )
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
