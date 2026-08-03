import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Database } from "@mf-rag/db/client";

import type { PreparedCuratedFaq } from "./prepare-curated-faq.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("curated FAQ review staging", () => {
  const sql = new SQL(testDatabaseUrl!);
  let database: Database;
  let packageClient: SQL;

  const prepared: PreparedCuratedFaq = {
    source: {
      id: "test-faq",
      title: "Investor FAQ",
      publisher: "Securities and Exchange Board of India",
      canonicalUrl: "https://www.sebi.gov.in/test-faq.pdf",
      sourceDate: "2024-09-25",
      sha256: "5".repeat(64),
      authority: "regulator",
      parserProfile: "sebi-unnumbered-v1",
      expectedQuestionCount: { min: 1, max: 1 },
      knowledgeDomain: "mutual_fund",
      sourceCollection: "general_mf_faq",
      documentKind: "FAQ",
      ownership: {
        visibilityScope: "GLOBAL",
        tenantId: null,
        ownershipManifestId: "curated-global-faq",
        ownershipManifestVersion: 1,
      },
    },
    artifactPath: "/tmp/test-faq.pdf",
    artifactReused: false,
    markdownPreviewPath: "/tmp/test-faq.md",
    chunkManifestPath: "/tmp/test-faq.json",
    parse: {
      profile: "sebi-unnumbered-v1",
      items: [{
        question: "How do I complete KYC?",
        answer: "Follow the applicable KYC requirements.",
        questionNumber: null,
        topic: "KYC",
        pageNumbers: [1],
      }],
      coverage: {
        sourceSegmentCount: 2,
        assignedSegmentCount: 2,
        excluded: [],
        unexplained: [],
      },
      warnings: [],
      blockers: [],
      reviewReady: true,
    },
    chunks: {
      totalChunks: 1,
      totalTokens: 14,
      chunks: [{
        text: "Source: Investor FAQ\nPublisher: Securities and Exchange Board of India\nQuestion: How do I complete KYC?\nAnswer: Follow the applicable KYC requirements.",
        chunkIndex: 0,
        pageNumbers: [1],
        hasTable: false,
        sectionHeader: "KYC",
        tokenCount: 14,
        faq: {
          sourceId: "test-faq",
          sourceTitle: "Investor FAQ",
          publisher: "Securities and Exchange Board of India",
          authority: "regulator",
          sourceUrl: "https://www.sebi.gov.in/test-faq.pdf",
          sourceDate: "2024-09-25",
          sourceChecksum: "5".repeat(64),
          sourceProfile: "sebi-unnumbered-v1",
          topic: "KYC",
          questionNumber: null,
          normalizedQuestionKey: "how do i complete kyc",
          originalQuestion: "How do I complete KYC?",
          continuationIndex: 0,
          firstPage: 1,
          lastPage: 1,
        },
      }],
    },
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

  test("same-checksum staging is a no-op and ownership mismatch cannot mutate status", async () => {
    const { stagePreparedCuratedFaqReview } = await import("./prepare-curated-faq.ts");
    const firstRun = await stagePreparedCuratedFaqReview(prepared, database);
    const [document] = await sql`
      SELECT id FROM documents WHERE file_hash = ${prepared.source.sha256}
    `;
    await sql`
      UPDATE ingestion_runs SET status = 'published' WHERE id = ${firstRun.id}::uuid
    `;
    await sql`
      UPDATE documents SET status = 'completed' WHERE id = ${document!.id}::uuid
    `;

    const repeatedRun = await stagePreparedCuratedFaqReview(prepared, database);
    expect(repeatedRun.id).toBe(firstRun.id);
    const [unchanged] = await sql`
      SELECT d.status AS document_status, r.status AS run_status
      FROM documents d
      JOIN ingestion_runs r ON r.source_document_id = d.id
      WHERE d.id = ${document!.id}::uuid
    `;
    expect(unchanged).toEqual(expect.objectContaining({
      document_status: "completed",
      run_status: "published",
    }));

    const mismatched: PreparedCuratedFaq = {
      ...prepared,
      source: {
        ...prepared.source,
        ownership: {
          ...prepared.source.ownership,
          ownershipManifestVersion: 2,
        },
      },
    };
    await expect(stagePreparedCuratedFaqReview(mismatched, database)).rejects.toThrow(
      "ownership does not match",
    );
    const [afterMismatch] = await sql`
      SELECT status, ownership_manifest_version
      FROM documents WHERE id = ${document!.id}::uuid
    `;
    expect(afterMismatch).toEqual(expect.objectContaining({
      status: "completed",
      ownership_manifest_version: 1,
    }));
  });

  test("staging a different authoritative answer creates a visible cross-run warning", async () => {
    await sql.unsafe(`TRUNCATE review_events, chunk_flags, chunk_candidates,
      ingestion_runs, chunks, documents CASCADE`);
    const { stagePreparedCuratedFaqReview } = await import("./prepare-curated-faq.ts");
    await stagePreparedCuratedFaqReview(prepared, database);

    const nismPrepared: PreparedCuratedFaq = {
      ...prepared,
      source: {
        ...prepared.source,
        id: "test-nism-faq",
        title: "Mutual Fund FAQs",
        publisher: "National Institute of Securities Markets",
        canonicalUrl: "https://www.nism.ac.in/test-faq.pdf",
        sourceDate: "2021-02-01",
        sha256: "6".repeat(64),
        authority: "sebi_established_institute",
        parserProfile: "nism-numbered-v1",
      },
      parse: {
        ...prepared.parse,
        profile: "nism-numbered-v1",
        items: [{
          ...prepared.parse.items[0]!,
          answer: "Complete KYC through the intermediary's current process.",
          questionNumber: "1",
        }],
      },
      chunks: {
        ...prepared.chunks,
        totalChunks: 2,
        chunks: [{
          ...prepared.chunks.chunks[0]!,
          text: "Source: Mutual Fund FAQs\nPublisher: National Institute of Securities Markets\nQuestion: How do I complete KYC?\nAnswer: Complete KYC through the intermediary's current process.",
          faq: {
            ...prepared.chunks.chunks[0]!.faq,
            sourceId: "test-nism-faq",
            sourceTitle: "Mutual Fund FAQs",
            publisher: "National Institute of Securities Markets",
            authority: "sebi_established_institute",
            sourceUrl: "https://www.nism.ac.in/test-faq.pdf",
            sourceDate: "2021-02-01",
            sourceChecksum: "6".repeat(64),
            sourceProfile: "nism-numbered-v1",
            questionNumber: "1",
          },
        }, {
          ...prepared.chunks.chunks[0]!,
          chunkIndex: 1,
          text: "Source: Mutual Fund FAQs\nPublisher: National Institute of Securities Markets\nQuestion: How do I update KYC?\nAnswer: Follow the current intermediary instructions.",
          faq: {
            ...prepared.chunks.chunks[0]!.faq,
            sourceId: "test-nism-faq",
            sourceTitle: "Mutual Fund FAQs",
            publisher: "National Institute of Securities Markets",
            authority: "sebi_established_institute",
            sourceUrl: "https://www.nism.ac.in/test-faq.pdf",
            sourceDate: "2021-02-01",
            sourceChecksum: "6".repeat(64),
            sourceProfile: "nism-numbered-v1",
            originalQuestion: "How do I update KYC?",
            normalizedQuestionKey: "how do i update kyc",
            questionNumber: "2",
          },
        }],
      },
    };

    const secondRun = await stagePreparedCuratedFaqReview(nismPrepared, database);
    const [warning] = await sql`
      SELECT r.warning_count, f.rule_code, f.status
      FROM ingestion_runs r
      JOIN chunk_flags f ON f.ingestion_run_id = r.id
      WHERE r.id = ${secondRun.id}::uuid
        AND f.rule_code = 'FAQ_CROSS_SOURCE_CONFLICT'
    `;
    expect(warning).toEqual(expect.objectContaining({
      rule_code: "FAQ_CROSS_SOURCE_CONFLICT",
      status: "open",
    }));
    expect(Number(warning?.warning_count)).toBeGreaterThanOrEqual(1);

    const { getReviewRunDetail, approveReviewRun } = await import("@mf-rag/db");
    const beforeEdit = await getReviewRunDetail(database, secondRun.id);
    const unrelated = beforeEdit!.candidates.find((candidate) => candidate.chunkIndex === 1)!;
    const { editReviewCandidate } = await import("../../../api/src/review/candidate-editor.ts");
    await editReviewCandidate(database, {
      candidateId: unrelated.id,
      expectedContentHash: unrelated.contentHash,
      text: "Source: Mutual Fund FAQs\nPublisher: National Institute of Securities Markets\nQuestion: How do I update KYC?\nAnswer: Follow current intermediary instructions.",
      editor: "reviewer@example.com",
      note: "Corrected unrelated FAQ wording.",
    });

    const afterEdit = await getReviewRunDetail(database, secondRun.id);
    expect(afterEdit!.flags).toContainEqual(expect.objectContaining({
      ruleCode: "FAQ_CROSS_SOURCE_CONFLICT",
      status: "open",
    }));
    const approval = await approveReviewRun(database, secondRun.id, "reviewer@example.com", "Reviewed");
    expect(approval.approved).toBe(false);
    expect(approval.reasons).toContain("Inspection warnings remain unacknowledged.");
  });
});
