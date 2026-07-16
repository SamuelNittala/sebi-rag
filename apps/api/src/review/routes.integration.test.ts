import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { Database } from "@mf-rag/db/client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("review routes", () => {
  const client = new SQL(testDatabaseUrl!);
  let db: Database;
  let packageClient: SQL;
  const authorization = `Basic ${btoa("reviewer:secret")}`;
  let app: Awaited<ReturnType<typeof import("./routes.ts")["createReviewApp"]>>;
  let runId = "";
  let flagId = "";
  let editRunId = "";
  let editCandidateId = "";
  let editCandidateHash = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const dbModule = await import("@mf-rag/db");
    db = dbModule.db;
    packageClient = dbModule.client;
    await client.unsafe(`TRUNCATE review_events, chunk_flags, chunk_candidates,
      ingestion_runs, documents CASCADE`);
    const [document] = await client`
      INSERT INTO documents (filename, filepath, file_hash, status)
      VALUES ('review-ui.pdf', '/tmp/review-ui.pdf', ${"d".repeat(64)}, 'review_required')
      RETURNING id
    `;
    const candidateId = crypto.randomUUID();
    const { stageInspectionReview } = await import("@mf-rag/db/review-queries");
    const run = await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: document!.id as string,
      sourceName: "review-ui.pdf",
      sourceLocation: "/tmp/review-ui.pdf",
      fileHash: "d".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "chunk-v1",
      report: {
        inspectorVersion: "inspect-v1",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        criticalCount: 1,
        warningCount: 0,
        blockingCount: 1,
        findings: [{
          candidateId,
          chunkIndex: 0,
          ruleCode: "TABLE_ROW_SPLIT",
          severity: "critical",
          blocksApproval: true,
          message: "Table row is split.",
          evidence: {},
        }],
      },
      candidates: [{
        id: candidateId,
        chunkIndex: 0,
        text: "ETF Product & Fund Manager",
        pageNumbers: [1],
        tokenCount: 5,
        hasTable: false,
        sectionHeader: "Fund Manager",
        metadata: { documentScope: "amc", sectionType: "staff_directory" },
        contentHash: "e".repeat(64),
      }],
    });
    runId = run.id;
    const [flag] = await client`select id from chunk_flags limit 1`;
    flagId = flag!.id as string;

    const [editableDocument] = await client`
      INSERT INTO documents (filename, filepath, file_hash, page_count, status)
      VALUES ('editable.pdf', '/tmp/editable.pdf', ${"f".repeat(64)}, 2, 'review_required')
      RETURNING id
    `;
    const editableCandidateId = crypto.randomUUID();
    const editableRun = await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: editableDocument!.id as string,
      sourceName: "editable.pdf",
      sourceLocation: "/tmp/editable.pdf",
      fileHash: "f".repeat(64),
      parserVersion: "pdf-v1",
      chunkerVersion: "chunk-v1",
      report: {
        inspectorVersion: "inspect-v1",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        criticalCount: 0,
        warningCount: 0,
        blockingCount: 0,
        findings: [],
      },
      candidates: [{
        id: editableCandidateId,
        chunkIndex: 0,
        text: "Original candidate text.",
        pageNumbers: [1],
        tokenCount: 4,
        hasTable: false,
        sectionHeader: null,
        metadata: { documentScope: "strategy", documentType: "ISID" },
        contentHash: "a".repeat(64),
      }],
    });
    editRunId = editableRun.id;
    const [persistedCandidate] = await client`
      select id, content_hash from chunk_candidates where ingestion_run_id = ${editRunId}
    `;
    editCandidateId = persistedCandidate!.id as string;
    editCandidateHash = persistedCandidate!.content_hash as string;
    const { createReviewApp } = await import("./routes.ts");
    app = createReviewApp(db, { username: "reviewer", password: "secret" });
  });

  afterAll(async () => {
    await packageClient.close();
    await client.close();
  });

  test("requires authentication", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(401);
  });

  test("shows every flagged chunk for a document", async () => {
    const response = await app.request(`/documents/${runId}`, {
      headers: { authorization },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("TABLE_ROW_SPLIT");
  });

  test("edits a candidate, records its revision, and reinspects the document", async () => {
    const editorResponse = await app.request(`/documents/${editRunId}/chunks`, {
      headers: { authorization },
    });
    expect(editorResponse.status).toBe(200);
    expect(await editorResponse.text()).toContain("Original candidate text.");

    const editResponse = await app.request(`/candidates/${editCandidateId}/edit`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: new URLSearchParams({
        expectedContentHash: editCandidateHash,
        text: "Corrected candidate text from the source PDF.",
        note: "Verified against page 1.",
      }),
    });
    expect(editResponse.status).toBe(303);

    const [candidate] = await client`
      select text from chunk_candidates where id = ${editCandidateId}
    `;
    expect(candidate?.text).toBe("Corrected candidate text from the source PDF.");
    const [revisionCount] = await client`
      select count(*)::int as count from chunk_candidate_edits where ingestion_run_id = ${editRunId}
    `;
    expect(revisionCount?.count).toBe(1);
  });

  test("records a flag decision and then permits document approval", async () => {
    const flagBody = new URLSearchParams({
      decision: "accepted",
      note: "Verified against the source PDF.",
    });
    const flagResponse = await app.request(`/flags/${flagId}`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: flagBody,
    });
    expect(flagResponse.status).toBe(303);

    const approvalResponse = await app.request(`/documents/${runId}/decision`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
      },
      body: new URLSearchParams({ decision: "approve", note: "Document reviewed." }),
    });
    expect(approvalResponse.status).toBe(303);

    const [run] = await client`select status from ingestion_runs where id = ${runId}`;
    expect(run?.status).toBe("approved");
  });
});
