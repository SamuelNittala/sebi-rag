import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type {
  ChunkFlagStatus,
  ReviewSourceType,
} from "@mf-rag/types";

import type { Database } from "./client.ts";
import {
  chunkCandidates,
  chunkCandidateEdits,
  chunkFlags,
  chunks,
  documents,
  htmlChunks,
  htmlDocuments,
  ingestionRuns,
  reviewEvents,
  type IngestionRun,
  type NewChunkCandidate,
} from "./schema.ts";

export interface PersistedInspectionFinding {
  candidateId: string | null;
  chunkIndex: number | null;
  ruleCode: string;
  severity: "critical" | "warning" | "info";
  blocksApproval: boolean;
  message: string;
  evidence: Record<string, unknown>;
}

export interface PersistedInspectionReport {
  inspectorVersion: string;
  candidateChunkCount: number;
  inspectedChunkCount: number;
  findings: PersistedInspectionFinding[];
  criticalCount: number;
  warningCount: number;
  blockingCount: number;
}

export interface StageInspectionReviewInput {
  sourceType: ReviewSourceType;
  sourceDocumentId: string;
  sourceName: string;
  sourceLocation?: string | null;
  fileHash: string;
  parserVersion: string;
  chunkerVersion: string;
  report: PersistedInspectionReport;
  candidates: Array<Omit<NewChunkCandidate, "ingestionRunId" | "createdAt">>;
}

export interface ChunkFlagDecisionInput {
  status: Exclude<ChunkFlagStatus, "open">;
  reviewer: string;
  note: string;
}

export interface ReviewRunDetail {
  run: typeof ingestionRuns.$inferSelect;
  candidates: Array<typeof chunkCandidates.$inferSelect>;
  flags: Array<typeof chunkFlags.$inferSelect>;
  edits: Array<typeof chunkCandidateEdits.$inferSelect>;
  events: Array<typeof reviewEvents.$inferSelect>;
}

export interface ApplyCandidateEditInspectionInput {
  ingestionRunId: string;
  candidateId: string;
  text: string;
  tokenCount: number;
  beforeContentHash: string;
  afterContentHash: string;
  editor: string;
  note: string;
  report: PersistedInspectionReport;
}

export interface ReviewApprovalResult {
  approved: boolean;
  reasons: string[];
  run: IngestionRun;
}

function validateInspection(input: StageInspectionReviewInput): void {
  if (input.report.candidateChunkCount !== input.candidates.length) {
    throw new Error("Inspection candidate count does not match persisted candidates.");
  }
  if (input.report.inspectedChunkCount !== input.candidates.length) {
    throw new Error("Not every candidate chunk was inspected.");
  }
}

export async function stageInspectionReview(
  db: Database,
  input: StageInspectionReviewInput,
): Promise<IngestionRun> {
  validateInspection(input);
  const flaggedChunkCount = new Set(
    input.report.findings.flatMap((item) => item.candidateId ? [item.candidateId] : []),
  ).size;
  // Inspector candidate IDs are deterministic within a document version. The
  // persisted IDs must be unique across historical reinspection runs.
  const persistedCandidateIds = new Map(
    input.candidates.map((candidate) => [candidate.id, crypto.randomUUID()]),
  );
  for (const finding of input.report.findings) {
    if (finding.candidateId && !persistedCandidateIds.has(finding.candidateId)) {
      throw new Error("Inspection finding references an unknown candidate.");
    }
  }

  return db.transaction(async (tx) => {
    const [run] = await tx.insert(ingestionRuns).values({
      sourceType: input.sourceType,
      sourceDocumentId: input.sourceDocumentId,
      sourceName: input.sourceName,
      sourceLocation: input.sourceLocation,
      fileHash: input.fileHash,
      parserVersion: input.parserVersion,
      chunkerVersion: input.chunkerVersion,
      inspectorVersion: input.report.inspectorVersion,
      status: "review_ready",
      candidateChunkCount: input.candidates.length,
      inspectedChunkCount: input.report.inspectedChunkCount,
      flaggedChunkCount,
      criticalCount: input.report.criticalCount,
      blockingCount: input.report.blockingCount,
    }).returning();
    if (!run) throw new Error("Failed to create ingestion review run.");

    if (input.candidates.length > 0) {
      await tx.insert(chunkCandidates).values(
        input.candidates.map((candidate) => ({
          ...candidate,
          id: persistedCandidateIds.get(candidate.id)!,
          ingestionRunId: run.id,
        })),
      );
    }
    if (input.report.findings.length > 0) {
      await tx.insert(chunkFlags).values(input.report.findings.map((item) => ({
        ingestionRunId: run.id,
        chunkCandidateId: item.candidateId
          ? persistedCandidateIds.get(item.candidateId)!
          : null,
        chunkIndex: item.chunkIndex,
        ruleCode: item.ruleCode,
        severity: item.severity,
        blocksApproval: item.blocksApproval,
        message: item.message,
        evidence: item.evidence,
        status: "open" as const,
      })));
    }
    await tx.insert(reviewEvents).values({
      ingestionRunId: run.id,
      eventType: "inspection_completed",
      actor: "system",
      details: {
        inspectorVersion: input.report.inspectorVersion,
        candidateChunkCount: input.candidates.length,
        findingCount: input.report.findings.length,
      },
    });

    // Drizzle's standard jsonb mapper serializes values before handing them to
    // Bun SQL. Bun SQL then serializes that string again, producing a JSONB
    // scalar instead of the intended array/object. Normalize review JSON while
    // it is still inside the staging transaction so UI and publisher consumers
    // always receive structured values.
    await tx.execute(sql`
      UPDATE ${chunkCandidates}
      SET
        ${chunkCandidates.pageNumbers} = CASE
          WHEN jsonb_typeof(${chunkCandidates.pageNumbers}) = 'string'
            THEN (${chunkCandidates.pageNumbers} #>> '{}')::jsonb
          ELSE ${chunkCandidates.pageNumbers}
        END,
        ${chunkCandidates.metadata} = CASE
          WHEN jsonb_typeof(${chunkCandidates.metadata}) = 'string'
            THEN (${chunkCandidates.metadata} #>> '{}')::jsonb
          ELSE ${chunkCandidates.metadata}
        END
      WHERE ${chunkCandidates.ingestionRunId} = ${run.id}
    `);
    await tx.execute(sql`
      UPDATE ${chunkFlags}
      SET ${chunkFlags.evidence} = (${chunkFlags.evidence} #>> '{}')::jsonb
      WHERE ${chunkFlags.ingestionRunId} = ${run.id}
        AND jsonb_typeof(${chunkFlags.evidence}) = 'string'
    `);
    await tx.execute(sql`
      UPDATE ${reviewEvents}
      SET ${reviewEvents.details} = (${reviewEvents.details} #>> '{}')::jsonb
      WHERE ${reviewEvents.ingestionRunId} = ${run.id}
        AND jsonb_typeof(${reviewEvents.details}) = 'string'
    `);
    return run;
  });
}

export async function listReviewRuns(db: Database): Promise<IngestionRun[]> {
  return db.select().from(ingestionRuns).orderBy(desc(ingestionRuns.createdAt));
}

export async function getReviewRunDetail(
  db: Database,
  runId: string,
): Promise<ReviewRunDetail | undefined> {
  const [run] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
  if (!run) return undefined;
  const [candidates, flags, edits, events] = await Promise.all([
    db.select().from(chunkCandidates)
      .where(eq(chunkCandidates.ingestionRunId, runId))
      .orderBy(asc(chunkCandidates.chunkIndex)),
    db.select().from(chunkFlags)
      .where(eq(chunkFlags.ingestionRunId, runId))
      .orderBy(asc(chunkFlags.chunkIndex), asc(chunkFlags.createdAt)),
    db.select().from(chunkCandidateEdits)
      .where(eq(chunkCandidateEdits.ingestionRunId, runId))
      .orderBy(desc(chunkCandidateEdits.createdAt)),
    db.select().from(reviewEvents)
      .where(eq(reviewEvents.ingestionRunId, runId))
      .orderBy(desc(reviewEvents.createdAt)),
  ]);
  return { run, candidates, flags, edits, events };
}

export async function getReviewRunDetailByCandidateId(
  db: Database,
  candidateId: string,
): Promise<ReviewRunDetail | undefined> {
  const [candidate] = await db.select({ ingestionRunId: chunkCandidates.ingestionRunId })
    .from(chunkCandidates)
    .where(eq(chunkCandidates.id, candidateId));
  return candidate ? getReviewRunDetail(db, candidate.ingestionRunId) : undefined;
}

export async function applyCandidateEditInspection(
  db: Database,
  input: ApplyCandidateEditInspectionInput,
): Promise<IngestionRun> {
  if (!input.note.trim()) throw new Error("An edit note is required.");
  if (!input.editor.trim()) throw new Error("An editor is required.");
  if (!input.text.trim()) throw new Error("Edited chunk text is required.");

  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(ingestionRuns)
      .where(eq(ingestionRuns.id, input.ingestionRunId));
    if (!run) throw new Error("Review run not found.");
    if (run.status !== "review_ready") {
      throw new Error("Only a review-ready run can be edited.");
    }
    const candidates = await tx.select().from(chunkCandidates)
      .where(eq(chunkCandidates.ingestionRunId, input.ingestionRunId));
    const candidate = candidates.find((item) => item.id === input.candidateId);
    if (!candidate) throw new Error("Chunk candidate not found.");
    if (candidate.contentHash !== input.beforeContentHash) {
      throw new Error("Chunk changed after this page was loaded.");
    }
    if (input.report.candidateChunkCount !== candidates.length
      || input.report.inspectedChunkCount !== candidates.length) {
      throw new Error("Every candidate must be reinspected after an edit.");
    }
    const candidateIds = new Set(candidates.map((item) => item.id));
    if (input.report.findings.some((finding) =>
      finding.candidateId && !candidateIds.has(finding.candidateId))) {
      throw new Error("Reinspection finding references an unknown candidate.");
    }

    const previousFlags = await tx.select().from(chunkFlags)
      .where(eq(chunkFlags.ingestionRunId, input.ingestionRunId));
    const [updatedCandidate] = await tx.update(chunkCandidates).set({
      text: input.text.trim(),
      tokenCount: input.tokenCount,
      contentHash: input.afterContentHash,
    }).where(and(
      eq(chunkCandidates.id, input.candidateId),
      eq(chunkCandidates.contentHash, input.beforeContentHash),
    )).returning();
    if (!updatedCandidate) throw new Error("Chunk changed after this page was loaded.");

    const [edit] = await tx.insert(chunkCandidateEdits).values({
      ingestionRunId: input.ingestionRunId,
      chunkCandidateId: candidate.id,
      chunkIndex: candidate.chunkIndex,
      beforeText: candidate.text,
      afterText: input.text.trim(),
      beforeContentHash: input.beforeContentHash,
      afterContentHash: input.afterContentHash,
      editor: input.editor,
      note: input.note.trim(),
    }).returning();
    await tx.delete(chunkFlags).where(eq(chunkFlags.ingestionRunId, input.ingestionRunId));
    if (input.report.findings.length > 0) {
      await tx.insert(chunkFlags).values(input.report.findings.map((finding) => ({
        ingestionRunId: input.ingestionRunId,
        chunkCandidateId: finding.candidateId,
        chunkIndex: finding.chunkIndex,
        ruleCode: finding.ruleCode,
        severity: finding.severity,
        blocksApproval: finding.blocksApproval,
        message: finding.message,
        evidence: finding.evidence,
        status: "open" as const,
      })));
    }

    const flaggedChunkCount = new Set(input.report.findings.flatMap((finding) =>
      finding.candidateId ? [finding.candidateId] : [])).size;
    const [updatedRun] = await tx.update(ingestionRuns).set({
      inspectorVersion: input.report.inspectorVersion,
      candidateChunkCount: input.report.candidateChunkCount,
      inspectedChunkCount: input.report.inspectedChunkCount,
      flaggedChunkCount,
      criticalCount: input.report.criticalCount,
      blockingCount: input.report.blockingCount,
      updatedAt: new Date(),
    }).where(eq(ingestionRuns.id, input.ingestionRunId)).returning();
    if (!updatedRun || !edit) throw new Error("Failed to persist the candidate edit.");

    await tx.insert(reviewEvents).values([
      {
        ingestionRunId: input.ingestionRunId,
        eventType: "chunk_edited",
        actor: input.editor,
        note: input.note.trim(),
        details: {
          editId: edit.id,
          candidateId: candidate.id,
          chunkIndex: candidate.chunkIndex,
          beforeContentHash: input.beforeContentHash,
          afterContentHash: input.afterContentHash,
        },
      },
      {
        ingestionRunId: input.ingestionRunId,
        eventType: "inspection_repeated",
        actor: "system",
        details: {
          inspectorVersion: input.report.inspectorVersion,
          findingCount: input.report.findings.length,
          previousFindings: previousFlags.map((flag) => ({
            chunkIndex: flag.chunkIndex,
            ruleCode: flag.ruleCode,
            severity: flag.severity,
            status: flag.status,
            message: flag.message,
          })),
        },
      },
    ]);
    return updatedRun;
  });
}

async function refreshOpenBlockingCount(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  runId: string,
): Promise<void> {
  const flags = await tx.select({
    status: chunkFlags.status,
    blocksApproval: chunkFlags.blocksApproval,
  }).from(chunkFlags).where(eq(chunkFlags.ingestionRunId, runId));
  const blockingCount = flags.filter((flag) => flag.status === "open" && flag.blocksApproval).length;
  await tx.update(ingestionRuns).set({ blockingCount, updatedAt: new Date() })
    .where(eq(ingestionRuns.id, runId));
}

export async function decideChunkFlag(
  db: Database,
  flagId: string,
  decision: ChunkFlagDecisionInput,
): Promise<typeof chunkFlags.$inferSelect> {
  if (!decision.note.trim()) throw new Error("A reviewer note is required.");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(chunkFlags).where(eq(chunkFlags.id, flagId));
    if (!existing) throw new Error("Chunk flag not found.");
    const [updated] = await tx.update(chunkFlags).set({
      status: decision.status,
      reviewer: decision.reviewer,
      reviewerNote: decision.note,
      reviewedAt: new Date(),
    }).where(and(eq(chunkFlags.id, flagId), eq(chunkFlags.status, "open"))).returning();
    if (!updated) throw new Error("Chunk flag has already been reviewed.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: existing.ingestionRunId,
      chunkFlagId: existing.id,
      eventType: `flag_${decision.status}`,
      actor: decision.reviewer,
      note: decision.note,
      details: { ruleCode: existing.ruleCode },
    });
    await refreshOpenBlockingCount(tx, existing.ingestionRunId);
    return updated;
  });
}

function approvalReasons(run: IngestionRun, openBlockingCount: number): string[] {
  const reasons: string[] = [];
  if (run.status !== "review_ready") reasons.push("Review run is not ready for review.");
  if (run.inspectedChunkCount !== run.candidateChunkCount) {
    reasons.push("Not every candidate chunk was inspected.");
  }
  if (openBlockingCount > 0) reasons.push("Blocking inspection findings remain open.");
  return reasons;
}

export async function approveReviewRun(
  db: Database,
  runId: string,
  reviewer: string,
  note: string,
): Promise<ReviewApprovalResult> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    if (!run) throw new Error("Review run not found.");
    const blockers = await tx.select({ id: chunkFlags.id }).from(chunkFlags).where(and(
      eq(chunkFlags.ingestionRunId, runId),
      eq(chunkFlags.status, "open"),
      eq(chunkFlags.blocksApproval, true),
    ));
    const reasons = approvalReasons(run, blockers.length);
    if (reasons.length > 0) return { approved: false, reasons, run };

    const [approved] = await tx.update(ingestionRuns).set({
      status: "approved",
      reviewer,
      reviewNote: note,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      blockingCount: 0,
    }).where(eq(ingestionRuns.id, runId)).returning();
    if (!approved) throw new Error("Failed to approve review run.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: "run_approved",
      actor: reviewer,
      note,
    });
    return { approved: true, reasons: [], run: approved };
  });
}

export async function rejectReviewRun(
  db: Database,
  runId: string,
  reviewer: string,
  note: string,
): Promise<IngestionRun> {
  if (!note.trim()) throw new Error("A rejection note is required.");
  return db.transaction(async (tx) => {
    const [run] = await tx.update(ingestionRuns).set({
      status: "rejected",
      reviewer,
      reviewNote: note,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(ingestionRuns.id, runId)).returning();
    if (!run) throw new Error("Review run not found.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: "run_rejected",
      actor: reviewer,
      note,
    });
    return run;
  });
}

export async function updateReviewRunStatus(
  db: Database,
  runId: string,
  expectedStatus: IngestionRun["status"],
  nextStatus: IngestionRun["status"],
  actor: string,
): Promise<IngestionRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx.update(ingestionRuns).set({
      status: nextStatus,
      updatedAt: new Date(),
    }).where(and(
      eq(ingestionRuns.id, runId),
      eq(ingestionRuns.status, expectedStatus),
    )).returning();
    if (!run) throw new Error(`Review run must be ${expectedStatus} before becoming ${nextStatus}.`);
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: `run_${nextStatus}`,
      actor,
    });
    return run;
  });
}

export async function markReviewRunFailed(
  db: Database,
  runId: string,
  actor: string,
  error: string,
): Promise<IngestionRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx.update(ingestionRuns).set({
      status: "failed",
      updatedAt: new Date(),
    }).where(and(
      eq(ingestionRuns.id, runId),
      or(
        eq(ingestionRuns.status, "embedding"),
        eq(ingestionRuns.status, "staged"),
      ),
    )).returning();
    if (!run) throw new Error("Only an embedding or staged review run can fail publication.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: "run_failed",
      actor,
      note: error,
    });
    return run;
  });
}

export async function publishReviewRun(
  db: Database,
  runId: string,
  actor: string,
): Promise<IngestionRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
    if (!run) throw new Error("Review run not found.");
    if (run.status !== "approved" && run.status !== "staged") {
      throw new Error("Only approved or staged review runs can be published.");
    }

    if (run.sourceType === "pdf") {
      const staged = await tx.select({ id: chunks.id }).from(chunks).where(and(
        eq(chunks.ingestionRunId, runId),
        eq(chunks.publicationStatus, "staged"),
      ));
      if (staged.length !== run.candidateChunkCount) {
        throw new Error("Staged PDF vector count does not match the approved candidate count.");
      }
      await tx.update(chunks).set({ publicationStatus: "retired" }).where(and(
        eq(chunks.documentId, run.sourceDocumentId),
        eq(chunks.publicationStatus, "published"),
        or(isNull(chunks.ingestionRunId), ne(chunks.ingestionRunId, runId)),
      ));
      await tx.update(chunks).set({ publicationStatus: "published" })
        .where(eq(chunks.ingestionRunId, runId));
      await tx.update(documents).set({
        status: "completed",
        chunkCount: run.candidateChunkCount,
        updatedAt: new Date(),
      }).where(eq(documents.id, run.sourceDocumentId));
    } else {
      const staged = await tx.select({ id: htmlChunks.id }).from(htmlChunks).where(and(
        eq(htmlChunks.ingestionRunId, runId),
        eq(htmlChunks.publicationStatus, "staged"),
      ));
      if (staged.length !== run.candidateChunkCount) {
        throw new Error("Staged HTML vector count does not match the approved candidate count.");
      }
      await tx.update(htmlChunks).set({ publicationStatus: "retired" }).where(and(
        eq(htmlChunks.documentId, run.sourceDocumentId),
        eq(htmlChunks.publicationStatus, "published"),
        or(isNull(htmlChunks.ingestionRunId), ne(htmlChunks.ingestionRunId, runId)),
      ));
      await tx.update(htmlChunks).set({ publicationStatus: "published" })
        .where(eq(htmlChunks.ingestionRunId, runId));
      await tx.update(htmlDocuments).set({
        status: "completed",
        chunkCount: run.candidateChunkCount,
        ingestedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(htmlDocuments.id, run.sourceDocumentId));
    }

    const [published] = await tx.update(ingestionRuns).set({
      status: "published",
      updatedAt: new Date(),
    }).where(eq(ingestionRuns.id, runId)).returning();
    if (!published) throw new Error("Failed to publish review run.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: "run_published",
      actor,
    });
    return published;
  });
}
