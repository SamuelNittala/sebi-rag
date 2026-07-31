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

  test("publishes globally scoped FAQ fields without fabricated scheme metadata", async () => {
    const [document] = await sql`
      INSERT INTO documents (
        filename, filepath, file_hash, doc_type, document_kind, title, publisher,
        source_url, source_date, authority, status, visibility_scope, tenant_id,
        ownership_manifest_id, ownership_manifest_version
      ) VALUES (
        'sebi-faq.pdf', '/tmp/sebi-faq.pdf', ${"9".repeat(64)}, 'FAQ', 'FAQ',
        'FAQs for Mutual Fund Investors', 'Securities and Exchange Board of India',
        'https://sebi.example/faq.pdf', '2024-09-25', 'regulator',
        'review_required', 'GLOBAL', NULL,
        ${globalOwnership.ownershipManifestId}, ${globalOwnership.ownershipManifestVersion}
      ) RETURNING id
    `;
    const { approveReviewRun, stageInspectionReview } = await import("@mf-rag/db");
    const run = await stageInspectionReview(database, {
      sourceType: "pdf",
      sourceDocumentId: document!.id as string,
      sourceName: "FAQs for Mutual Fund Investors",
      sourceLocation: "https://sebi.example/faq.pdf",
      fileHash: "9".repeat(64),
      parserVersion: "sebi-unnumbered-v1",
      chunkerVersion: "faq-semantic-v1",
      ownership: globalOwnership,
      report: {
        inspectorVersion: "1.1.0",
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
        text: "Question: How do I complete KYC?\nAnswer: Follow the applicable KYC process.",
        pageNumbers: [4, 5],
        tokenCount: 16,
        hasTable: false,
        sectionHeader: "KYC",
        metadata: {
          documentScope: "regulatory",
          documentKind: "FAQ",
          documentTitle: "FAQs for Mutual Fund Investors",
          publisher: "Securities and Exchange Board of India",
          authority: "regulator",
          sourceUrl: "https://sebi.example/faq.pdf",
          sourceDate: "2024-09-25",
          topic: "KYC",
          normalizedQuestionKey: "how do i complete kyc",
          originalQuestion: "How do I complete KYC?",
          answer: "Follow the applicable KYC process.",
          continuationIndex: 0,
          documentType: "FAQ",
          knowledgeDomain: "mutual_fund",
          sourceCollection: "general_mf_faq",
        },
        contentHash: "8".repeat(64),
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
          tokenCount: 16,
        };
      }),
    };
    const { publishApprovedReviewRun } = await import("./review-publisher.ts");
    await publishApprovedReviewRun(run.id, {
      actor: "publisher@example.com",
      database,
      embedder,
    });

    const [stored] = await sql`
      SELECT document_kind, document_title, publisher, source_url, source_date,
        authority, topic, normalized_question_key, original_question,
        fund_name, amc_name, scheme_type, scheme_category, sebi_scheme_id, sebi_url,
        visibility_scope, tenant_id
      FROM chunks WHERE ingestion_run_id = ${run.id}::uuid
    `;
    expect(stored).toEqual(expect.objectContaining({
      document_kind: "FAQ",
      document_title: "FAQs for Mutual Fund Investors",
      publisher: "Securities and Exchange Board of India",
      source_url: "https://sebi.example/faq.pdf",
      source_date: "2024-09-25",
      authority: "regulator",
      topic: "KYC",
      normalized_question_key: "how do i complete kyc",
      original_question: "How do I complete KYC?",
      fund_name: null,
      amc_name: null,
      scheme_type: null,
      scheme_category: null,
      sebi_scheme_id: null,
      sebi_url: null,
      visibility_scope: "GLOBAL",
      tenant_id: null,
    }));
    expect(embeddedTexts[0]).toContain("Publisher: Securities and Exchange Board of India");
    expect(embeddedTexts[0]).toContain("Topic: KYC");
    expect(embeddedTexts[0]).toContain("Question: How do I complete KYC?");
  });

  test("keeps the published FAQ active when an unreviewed cross-source exact duplicate fails", async () => {
    const [document] = await sql`
      INSERT INTO documents (
        filename, filepath, file_hash, doc_type, document_kind, title, publisher,
        source_url, source_date, authority, status, visibility_scope, tenant_id,
        ownership_manifest_id, ownership_manifest_version
      ) VALUES (
        'nism-faq.pdf', '/tmp/nism-faq.pdf', ${"7".repeat(64)}, 'FAQ', 'FAQ',
        'Mutual Fund FAQs', 'National Institute of Securities Markets',
        'https://nism.example/faq.pdf', '2021-02-01', 'sebi_established_institute',
        'review_required', 'GLOBAL', NULL,
        ${globalOwnership.ownershipManifestId}, ${globalOwnership.ownershipManifestVersion}
      ) RETURNING id
    `;
    const { approveReviewRun, stageInspectionReview } = await import("@mf-rag/db");
    const run = await stageInspectionReview(database, {
      sourceType: "pdf",
      sourceDocumentId: document!.id as string,
      sourceName: "Mutual Fund FAQs",
      sourceLocation: "https://nism.example/faq.pdf",
      fileHash: "7".repeat(64),
      parserVersion: "nism-numbered-v1",
      chunkerVersion: "faq-semantic-v1",
      ownership: globalOwnership,
      report: {
        inspectorVersion: "1.1.0",
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
        text: "Question: How do I complete KYC?\nAnswer: Follow the applicable KYC process.",
        pageNumbers: [12],
        tokenCount: 16,
        hasTable: false,
        sectionHeader: "KYC",
        metadata: {
          documentScope: "regulatory",
          documentKind: "FAQ",
          documentTitle: "Mutual Fund FAQs",
          publisher: "National Institute of Securities Markets",
          authority: "sebi_established_institute",
          sourceUrl: "https://nism.example/faq.pdf",
          sourceDate: "2021-02-01",
          topic: "KYC",
          normalizedQuestionKey: "how do i complete kyc",
          originalQuestion: "How do I complete KYC?",
          answer: "Follow the applicable KYC process.",
          continuationIndex: 0,
          documentType: "FAQ",
          knowledgeDomain: "mutual_fund",
          sourceCollection: "general_mf_faq",
        },
        contentHash: "6".repeat(64),
      }],
    });
    await approveReviewRun(database, run.id, "reviewer@example.com", "Verified");
    const embedder: Embedder = {
      embed: async () => new Array(1024).fill(0),
      embedBatch: async (inputs) => inputs.map((input) => ({
        chunkIndex: input.chunkIndex,
        embedding: new Array(1024).fill(0),
        tokenCount: 16,
      })),
    };
    const { publishApprovedReviewRun } = await import("./review-publisher.ts");
    await expect(publishApprovedReviewRun(run.id, {
      actor: "publisher@example.com",
      database,
      embedder,
    })).rejects.toThrow("intentional duplicate disposition");
    const [failed] = await sql`
      SELECT status FROM ingestion_runs WHERE id = ${run.id}::uuid
    `;
    expect(failed?.status).toBe("failed");
    const [prior] = await sql`
      SELECT count(*)::int AS count FROM chunks
      WHERE source_url = 'https://sebi.example/faq.pdf'
        AND publication_status = 'published'
    `;
    expect(prior?.count).toBe(1);
  });

  test("serializes concurrent intentional duplicate publication across distinct authorities", async () => {
    const { approveReviewRun, stageInspectionReview } = await import("@mf-rag/db");
    const { publishApprovedReviewRun } = await import("./review-publisher.ts");
    const createRun = async (input: {
      filename: string;
      fileHash: string;
      contentHash: string;
      title: string;
      publisher: string;
      sourceUrl: string;
      authority: "regulator" | "sebi_established_institute";
    }) => {
      const [document] = await sql`
        INSERT INTO documents (
          filename, filepath, file_hash, doc_type, document_kind, title, publisher,
          source_url, source_date, authority, status, visibility_scope, tenant_id,
          ownership_manifest_id, ownership_manifest_version
        ) VALUES (
          ${input.filename}, ${`/tmp/${input.filename}`}, ${input.fileHash}, 'FAQ', 'FAQ',
          ${input.title}, ${input.publisher}, ${input.sourceUrl}, '2024-01-01',
          ${input.authority}, 'review_required', 'GLOBAL', NULL,
          ${globalOwnership.ownershipManifestId}, ${globalOwnership.ownershipManifestVersion}
        ) RETURNING id
      `;
      const run = await stageInspectionReview(database, {
        sourceType: "pdf",
        sourceDocumentId: document!.id as string,
        sourceName: input.title,
        sourceLocation: input.sourceUrl,
        fileHash: input.fileHash,
        parserVersion: "faq-test-v1",
        chunkerVersion: "faq-semantic-v1",
        ownership: globalOwnership,
        report: {
          inspectorVersion: "1.1.0",
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
          text: "Question: What is a folio number?\nAnswer: It identifies an investor's mutual-fund account.",
          pageNumbers: [8],
          tokenCount: 18,
          hasTable: false,
          sectionHeader: "Investor Accounts",
          metadata: {
            documentScope: "regulatory",
            documentKind: "FAQ",
            documentTitle: input.title,
            publisher: input.publisher,
            authority: input.authority,
            sourceUrl: input.sourceUrl,
            sourceDate: "2024-01-01",
            topic: "Investor Accounts",
            normalizedQuestionKey: "what is a folio number",
            originalQuestion: "What is a folio number?",
            answer: "It identifies an investor's mutual-fund account.",
            continuationIndex: 0,
            intentionalDuplicateDisposition: "retain_distinct_authority",
            documentType: "FAQ",
            knowledgeDomain: "mutual_fund",
            sourceCollection: "general_mf_faq",
          },
          contentHash: input.contentHash,
        }],
      });
      await approveReviewRun(database, run.id, "reviewer@example.com", "Distinct authority retained");
      return run;
    };

    const regulatorRun = await createRun({
      filename: "regulator-folio-faq.pdf",
      fileHash: "1".repeat(64),
      contentHash: "3".repeat(64),
      title: "Regulator Investor FAQ",
      publisher: "Securities and Exchange Board of India",
      sourceUrl: "https://sebi.example/folio-faq.pdf",
      authority: "regulator",
    });
    const instituteRun = await createRun({
      filename: "institute-folio-faq.pdf",
      fileHash: "2".repeat(64),
      contentHash: "4".repeat(64),
      title: "Institute Mutual Fund FAQ",
      publisher: "National Institute of Securities Markets",
      sourceUrl: "https://nism.example/folio-faq.pdf",
      authority: "sebi_established_institute",
    });
    const embedder: Embedder = {
      embed: async () => new Array(1024).fill(0),
      embedBatch: async (inputs) => inputs.map((input) => ({
        chunkIndex: input.chunkIndex,
        embedding: new Array(1024).fill(0),
        tokenCount: 18,
      })),
    };

    const published = await Promise.all([
      publishApprovedReviewRun(regulatorRun.id, {
        actor: "publisher@example.com",
        database,
        embedder,
      }),
      publishApprovedReviewRun(instituteRun.id, {
        actor: "publisher@example.com",
        database,
        embedder,
      }),
    ]);
    expect(published.map((run) => run.status)).toEqual(["published", "published"]);
    const [retained] = await sql`
      SELECT count(*)::int AS count, count(DISTINCT document_id)::int AS documents
      FROM chunks
      WHERE normalized_question_key = 'what is a folio number'
        AND publication_status = 'published'
    `;
    expect(retained).toEqual(expect.objectContaining({
      count: 2,
      documents: 2,
    }));
  });
});
