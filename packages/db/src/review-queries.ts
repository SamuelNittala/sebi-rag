import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type {
  CandidateChunkMetadata,
  ClassifiedKnowledgeOwnership,
  ChunkFlagStatus,
  KnowledgeOwnership,
  ReviewPurpose,
  ReviewSourceType,
} from "@mf-rag/types";
import {
  assertClassifiedKnowledgeOwnership,
  isCuratedFaqMetadata,
} from "@mf-rag/types";

import type { Database } from "./client.ts";
import {
  chunkCandidates,
  chunkCandidateEdits,
  chunkFlags,
  chunkSearchDocuments,
  chunks,
  documents,
  htmlChunks,
  htmlChunkSearchDocuments,
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
  reviewPurpose?: ReviewPurpose;
  sourceDocumentId: string;
  sourceName: string;
  sourceLocation?: string | null;
  fileHash: string;
  parserVersion: string;
  chunkerVersion: string;
  ownership: ClassifiedKnowledgeOwnership;
  report: PersistedInspectionReport;
  candidates: Array<Omit<
    NewChunkCandidate,
    | "ingestionRunId"
    | "createdAt"
    | "visibilityScope"
    | "tenantId"
    | "ownershipManifestId"
    | "ownershipManifestVersion"
  >>;
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
  metadata: CandidateChunkMetadata;
  editor: string;
  note: string;
  report: PersistedInspectionReport;
}

export interface ReviewApprovalResult {
  approved: boolean;
  reasons: string[];
  run: IngestionRun;
}

export interface UpdateReviewCandidateMetadataInput {
  ingestionRunId: string;
  candidateId: string;
  expectedContentHash: string;
  metadata: CandidateChunkMetadata;
  editor: string;
  note: string;
}

export async function updateReviewCandidateMetadata(
  db: Database,
  input: UpdateReviewCandidateMetadataInput,
): Promise<IngestionRun> {
  if (!input.editor.trim()) throw new Error("An editor is required.");
  if (!input.note.trim()) throw new Error("A metadata review note is required.");
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(ingestionRuns)
      .where(eq(ingestionRuns.id, input.ingestionRunId));
    if (!run) throw new Error("Review run not found.");
    if (run.reviewPurpose !== "metadata" || run.status !== "review_ready") {
      throw new Error("Only a review-ready metadata run can be edited.");
    }
    const [candidate] = await tx.select().from(chunkCandidates).where(and(
      eq(chunkCandidates.id, input.candidateId),
      eq(chunkCandidates.ingestionRunId, input.ingestionRunId),
    ));
    if (!candidate) throw new Error("Chunk candidate not found.");
    if (candidate.contentHash !== input.expectedContentHash) {
      throw new Error("Chunk changed after this page was loaded.");
    }
    const [updated] = await tx.update(chunkCandidates).set({ metadata: input.metadata }).where(and(
      eq(chunkCandidates.id, input.candidateId),
      eq(chunkCandidates.contentHash, input.expectedContentHash),
    )).returning();
    if (!updated) throw new Error("Chunk changed after this page was loaded.");
    await tx.execute(sql`
      UPDATE ${chunkCandidates}
      SET metadata = (${chunkCandidates.metadata} #>> '{}')::jsonb
      WHERE ${chunkCandidates.id} = ${input.candidateId}
        AND jsonb_typeof(${chunkCandidates.metadata}) = 'string'
    `);
    await tx.update(chunkFlags).set({
      status: "resolved",
      reviewer: input.editor,
      reviewerNote: input.note.trim(),
      reviewedAt: new Date(),
    }).where(and(
      eq(chunkFlags.ingestionRunId, input.ingestionRunId),
      eq(chunkFlags.chunkCandidateId, input.candidateId),
      eq(chunkFlags.status, "open"),
    ));
    const openFlags = await tx.select().from(chunkFlags).where(and(
      eq(chunkFlags.ingestionRunId, input.ingestionRunId),
      eq(chunkFlags.status, "open"),
    ));
    const [updatedRun] = await tx.update(ingestionRuns).set({
      flaggedChunkCount: new Set(openFlags.flatMap((flag) => flag.chunkCandidateId ? [flag.chunkCandidateId] : [])).size,
      criticalCount: openFlags.filter((flag) => flag.severity === "critical").length,
      warningCount: openFlags.filter((flag) => flag.severity === "warning").length,
      blockingCount: openFlags.filter((flag) => flag.blocksApproval).length,
      updatedAt: new Date(),
    }).where(eq(ingestionRuns.id, input.ingestionRunId)).returning();
    if (!updatedRun) throw new Error("Failed to update metadata review run.");
    const [event] = await tx.insert(reviewEvents).values({
      ingestionRunId: input.ingestionRunId,
      eventType: "metadata_edited",
      actor: input.editor,
      note: input.note.trim(),
      details: {
        candidateId: input.candidateId,
        chunkIndex: candidate.chunkIndex,
        before: candidate.metadata,
        after: input.metadata,
      },
    }).returning({ id: reviewEvents.id });
    if (event) {
      await tx.execute(sql`
        UPDATE ${reviewEvents}
        SET details = (${reviewEvents.details} #>> '{}')::jsonb
        WHERE ${reviewEvents.id} = ${event.id}
          AND jsonb_typeof(${reviewEvents.details}) = 'string'
      `);
    }
    return updatedRun;
  });
}

function validateInspection(input: StageInspectionReviewInput): void {
  assertClassifiedKnowledgeOwnership(input.ownership);
  if (input.report.candidateChunkCount !== input.candidates.length) {
    throw new Error("Inspection candidate count does not match persisted candidates.");
  }
  if (input.report.inspectedChunkCount !== input.candidates.length) {
    throw new Error("Not every candidate chunk was inspected.");
  }
}

interface OwnershipRecord {
  visibilityScope: KnowledgeOwnership["visibilityScope"];
  tenantId: string | null;
  ownershipManifestId: string | null;
  ownershipManifestVersion: number | null;
}

function ownershipMatches(
  record: OwnershipRecord,
  ownership: ClassifiedKnowledgeOwnership,
): boolean {
  return record.visibilityScope === ownership.visibilityScope
    && record.tenantId === ownership.tenantId
    && record.ownershipManifestId === ownership.ownershipManifestId
    && record.ownershipManifestVersion === ownership.ownershipManifestVersion;
}

function metadataObject(
  value: CandidateChunkMetadata | string | null,
): CandidateChunkMetadata {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as CandidateChunkMetadata;
    } catch {
      return { documentScope: "unknown" };
    }
  }
  return value ?? { documentScope: "unknown" };
}

function normalizedFaqAnswer(metadata: CandidateChunkMetadata): string {
  return typeof metadata.answer === "string"
    ? metadata.answer.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
    : "";
}

interface CrossRunFaqCandidate {
  id: string;
  chunkIndex: number;
  metadata: CandidateChunkMetadata;
}

async function crossRunFaqWarnings(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  sourceDocumentId: string,
  candidates: CrossRunFaqCandidate[],
): Promise<PersistedInspectionFinding[]> {
  const faqCandidates = candidates.filter((candidate) =>
    isCuratedFaqMetadata(candidate.metadata)
  );
  if (faqCandidates.length === 0) return [];
  const priorFaqCandidates = await tx.select({
    id: chunkCandidates.id,
    metadata: chunkCandidates.metadata,
    runStatus: ingestionRuns.status,
  }).from(chunkCandidates).innerJoin(
    ingestionRuns,
    eq(chunkCandidates.ingestionRunId, ingestionRuns.id),
  ).where(ne(ingestionRuns.sourceDocumentId, sourceDocumentId));
  return faqCandidates.flatMap(({ id, chunkIndex, metadata }) => {
    const question = metadata.normalizedQuestionKey?.trim();
    const answer = normalizedFaqAnswer(metadata);
    if (!question || !answer) return [];
    const conflict = priorFaqCandidates.find((prior) => {
      if (prior.runStatus === "failed") return false;
      const priorMetadata = metadataObject(prior.metadata);
      const priorAnswer = normalizedFaqAnswer(priorMetadata);
      return priorMetadata.normalizedQuestionKey?.trim() === question
        && priorMetadata.sourceUrl !== metadata.sourceUrl
        && Boolean(priorAnswer)
        && priorAnswer !== answer;
    });
    if (!conflict) return [];
    const conflictMetadata = metadataObject(conflict.metadata);
    return [{
      candidateId: id,
      chunkIndex,
      ruleCode: "FAQ_CROSS_SOURCE_CONFLICT",
      severity: "warning" as const,
      blocksApproval: false,
      message: "A separately staged authoritative source provides a materially different answer to the same normalized question.",
      evidence: {
        comparedCandidateId: conflict.id,
        sourceUrls: [conflictMetadata.sourceUrl ?? null, metadata.sourceUrl ?? null],
        sourceDates: [conflictMetadata.sourceDate ?? null, metadata.sourceDate ?? null],
      },
    }];
  });
}

function hasLexicalSearchDocument(chunk: {
  knowledgeDomain: string;
  sourceCollection: string;
}): boolean {
  return (
    chunk.knowledgeDomain === "sif"
    && chunk.sourceCollection === "mirae_sif"
  ) || (
    chunk.knowledgeDomain === "mutual_fund"
    && chunk.sourceCollection === "general_mf_faq"
  );
}

async function assertFaqDuplicateDisposition(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  sourceDocumentId: string,
  candidates: Array<{ metadata: CandidateChunkMetadata; text: string }>,
): Promise<void> {
  const faqCandidates = candidates.filter((candidate) =>
    isCuratedFaqMetadata(candidate.metadata)
  );
  if (faqCandidates.length === 0) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('general_mf_faq:publication'))`);
  const published = await tx.select({
    documentId: chunks.documentId,
    metadata: chunks.retrievalMetadata,
  }).from(chunks).where(and(
    eq(chunks.publicationStatus, "published"),
    eq(chunks.sourceCollection, "general_mf_faq"),
  ));
  for (const candidate of faqCandidates) {
    const question = candidate.metadata.normalizedQuestionKey?.trim();
    const answer = normalizedFaqAnswer(candidate.metadata);
    if (!question || !answer) continue;
    const duplicate = published.find((row) => {
      if (row.documentId === sourceDocumentId) return false;
      const metadata = metadataObject(row.metadata);
      return metadata.normalizedQuestionKey === question
        && normalizedFaqAnswer(metadata) === answer;
    });
    if (!duplicate) continue;
    if (candidate.metadata.intentionalDuplicateDisposition !== "retain_distinct_authority") {
      throw new Error(
        "Published FAQ contains the same normalized question and answer; reviewed intentional duplicate disposition is required.",
      );
    }
    const existingMetadata = metadataObject(duplicate.metadata);
    if (
      existingMetadata.sourceUrl === candidate.metadata.sourceUrl
      || existingMetadata.authority === candidate.metadata.authority
    ) {
      throw new Error(
        "Intentional FAQ duplicate retention requires a distinct source and authority.",
      );
    }
  }
}

function classifiedOwnershipFromRecord(record: OwnershipRecord): ClassifiedKnowledgeOwnership {
  const ownership = {
    visibilityScope: record.visibilityScope,
    tenantId: record.tenantId,
    ownershipManifestId: record.ownershipManifestId,
    ownershipManifestVersion: record.ownershipManifestVersion,
  } as KnowledgeOwnership;
  assertClassifiedKnowledgeOwnership(ownership);
  return ownership;
}

async function lockReviewSource(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  sourceType: ReviewSourceType,
  sourceDocumentId: string,
): Promise<(OwnershipRecord & { fileHash: string }) | undefined> {
  if (sourceType === "pdf") {
    await tx.execute(sql`
      SELECT ${documents.id}
      FROM ${documents}
      WHERE ${documents.id} = ${sourceDocumentId}
      FOR UPDATE
    `);
    const [source] = await tx.select({
      fileHash: documents.fileHash,
      visibilityScope: documents.visibilityScope,
      tenantId: documents.tenantId,
      ownershipManifestId: documents.ownershipManifestId,
      ownershipManifestVersion: documents.ownershipManifestVersion,
    }).from(documents).where(eq(documents.id, sourceDocumentId));
    return source;
  }
  await tx.execute(sql`
    SELECT ${htmlDocuments.id}
    FROM ${htmlDocuments}
    WHERE ${htmlDocuments.id} = ${sourceDocumentId}
    FOR UPDATE
  `);
  const [source] = await tx.select({
    fileHash: htmlDocuments.fileHash,
    visibilityScope: htmlDocuments.visibilityScope,
    tenantId: htmlDocuments.tenantId,
    ownershipManifestId: htmlDocuments.ownershipManifestId,
    ownershipManifestVersion: htmlDocuments.ownershipManifestVersion,
  }).from(htmlDocuments).where(eq(htmlDocuments.id, sourceDocumentId));
  return source;
}

export async function stageInspectionReview(
  db: Database,
  input: StageInspectionReviewInput,
): Promise<IngestionRun> {
  validateInspection(input);
  const candidatesWithIds = input.candidates.map((candidate) => {
    if (!candidate.id) {
      throw new Error("Inspection candidates require stable IDs.");
    }
    return { ...candidate, id: candidate.id };
  });
  // Inspector candidate IDs are deterministic within a document version. The
  // persisted IDs must be unique across historical reinspection runs.
  const persistedCandidateIds = new Map(
    candidatesWithIds.map((candidate) => [candidate.id, crypto.randomUUID()]),
  );
  for (const finding of input.report.findings) {
    if (finding.candidateId && !persistedCandidateIds.has(finding.candidateId)) {
      throw new Error("Inspection finding references an unknown candidate.");
    }
  }

  return db.transaction(async (tx) => {
    const source = await lockReviewSource(tx, input.sourceType, input.sourceDocumentId);
    if (!source) throw new Error("Typed review source document not found.");
    const sourceOwnership = classifiedOwnershipFromRecord(source);
    if (!ownershipMatches(sourceOwnership, input.ownership)) {
      throw new Error("Trusted ownership does not match the source document ownership.");
    }
    if ((input.reviewPurpose ?? "content") === "content" && source.fileHash !== input.fileHash) {
      throw new Error("Source document changed before review staging.");
    }

    const crossRunWarnings = await crossRunFaqWarnings(
      tx,
      input.sourceDocumentId,
      candidatesWithIds.map((candidate) => ({
        id: candidate.id,
        chunkIndex: candidate.chunkIndex,
        metadata: metadataObject(candidate.metadata),
      })),
    );
    const findings = [...input.report.findings, ...crossRunWarnings];
    const flaggedChunkCount = new Set(
      findings.flatMap((item) => item.candidateId ? [item.candidateId] : []),
    ).size;
    const [run] = await tx.insert(ingestionRuns).values({
      sourceType: input.sourceType,
      reviewPurpose: input.reviewPurpose ?? "content",
      sourceDocumentId: input.sourceDocumentId,
      sourceName: input.sourceName,
      sourceLocation: input.sourceLocation,
      fileHash: input.fileHash,
      parserVersion: input.parserVersion,
      chunkerVersion: input.chunkerVersion,
      inspectorVersion: input.report.inspectorVersion,
      status: "review_ready",
      candidateChunkCount: candidatesWithIds.length,
      inspectedChunkCount: input.report.inspectedChunkCount,
      flaggedChunkCount,
      criticalCount: input.report.criticalCount,
      warningCount: input.report.warningCount + crossRunWarnings.length,
      blockingCount: input.report.blockingCount,
      ...input.ownership,
    }).returning();
    if (!run) throw new Error("Failed to create ingestion review run.");

    if (candidatesWithIds.length > 0) {
      await tx.insert(chunkCandidates).values(
        candidatesWithIds.map((candidate) => ({
          ...candidate,
          id: persistedCandidateIds.get(candidate.id)!,
          ingestionRunId: run.id,
          ...input.ownership,
        })),
      );
    }
    if (findings.length > 0) {
      await tx.insert(chunkFlags).values(findings.map((item) => ({
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
        findingCount: findings.length,
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
        page_numbers = CASE
          WHEN jsonb_typeof(${chunkCandidates.pageNumbers}) = 'string'
            THEN (${chunkCandidates.pageNumbers} #>> '{}')::jsonb
          ELSE ${chunkCandidates.pageNumbers}
        END,
        metadata = CASE
          WHEN jsonb_typeof(${chunkCandidates.metadata}) = 'string'
            THEN (${chunkCandidates.metadata} #>> '{}')::jsonb
          ELSE ${chunkCandidates.metadata}
        END
      WHERE ${chunkCandidates.ingestionRunId} = ${run.id}
    `);
    await tx.execute(sql`
      UPDATE ${chunkFlags}
      SET evidence = (${chunkFlags.evidence} #>> '{}')::jsonb
      WHERE ${chunkFlags.ingestionRunId} = ${run.id}
        AND jsonb_typeof(${chunkFlags.evidence}) = 'string'
    `);
    await tx.execute(sql`
      UPDATE ${reviewEvents}
      SET details = (${reviewEvents.details} #>> '{}')::jsonb
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
      metadata: input.metadata,
    }).where(and(
      eq(chunkCandidates.id, input.candidateId),
      eq(chunkCandidates.contentHash, input.beforeContentHash),
    )).returning();
    if (!updatedCandidate) throw new Error("Chunk changed after this page was loaded.");
    await tx.execute(sql`
      UPDATE ${chunkCandidates}
      SET metadata = (${chunkCandidates.metadata} #>> '{}')::jsonb
      WHERE ${chunkCandidates.id} = ${input.candidateId}
        AND jsonb_typeof(${chunkCandidates.metadata}) = 'string'
    `);

    const crossRunWarnings = await crossRunFaqWarnings(
      tx,
      run.sourceDocumentId,
      candidates.map((item) => ({
        id: item.id,
        chunkIndex: item.chunkIndex,
        metadata: item.id === input.candidateId
          ? input.metadata
          : metadataObject(item.metadata),
      })),
    );
    const findings = [...input.report.findings, ...crossRunWarnings];

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
    if (findings.length > 0) {
      await tx.insert(chunkFlags).values(findings.map((finding) => ({
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

    const flaggedChunkCount = new Set(findings.flatMap((finding) =>
      finding.candidateId ? [finding.candidateId] : [])).size;
    const [updatedRun] = await tx.update(ingestionRuns).set({
      inspectorVersion: input.report.inspectorVersion,
      candidateChunkCount: input.report.candidateChunkCount,
      inspectedChunkCount: input.report.inspectedChunkCount,
      flaggedChunkCount,
      criticalCount: input.report.criticalCount,
      warningCount: input.report.warningCount + crossRunWarnings.length,
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
          findingCount: findings.length,
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

async function refreshOpenFindingCounts(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  runId: string,
): Promise<void> {
  const flags = await tx.select({
    status: chunkFlags.status,
    blocksApproval: chunkFlags.blocksApproval,
    severity: chunkFlags.severity,
  }).from(chunkFlags).where(eq(chunkFlags.ingestionRunId, runId));
  const open = flags.filter((flag) => flag.status === "open");
  const blockingCount = open.filter((flag) => flag.blocksApproval).length;
  const warningCount = open.filter((flag) => flag.severity === "warning").length;
  await tx.update(ingestionRuns).set({ blockingCount, warningCount, updatedAt: new Date() })
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
    await refreshOpenFindingCounts(tx, existing.ingestionRunId);
    return updated;
  });
}

function approvalReasons(
  run: IngestionRun,
  openBlockingCount: number,
  openWarningCount: number,
): string[] {
  const reasons: string[] = [];
  if (run.status !== "review_ready") reasons.push("Review run is not ready for review.");
  if (run.inspectedChunkCount !== run.candidateChunkCount) {
    reasons.push("Not every candidate chunk was inspected.");
  }
  if (openBlockingCount > 0) reasons.push("Blocking inspection findings remain open.");
  if (openWarningCount > 0) reasons.push("Inspection warnings remain unacknowledged.");
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
    const warnings = await tx.select({ id: chunkFlags.id }).from(chunkFlags).where(and(
      eq(chunkFlags.ingestionRunId, runId),
      eq(chunkFlags.status, "open"),
      eq(chunkFlags.blocksApproval, false),
      eq(chunkFlags.severity, "warning"),
    ));
    const reasons = approvalReasons(run, blockers.length, warnings.length);
    let runOwnership: ClassifiedKnowledgeOwnership | undefined;
    try {
      runOwnership = classifiedOwnershipFromRecord(run);
    } catch {
      reasons.push("Review run ownership is missing or unclassified.");
    }
    const source = await lockReviewSource(tx, run.sourceType, run.sourceDocumentId);
    if (!source) {
      reasons.push("Typed review source document not found.");
    } else if (runOwnership && !ownershipMatches(source, runOwnership)) {
      reasons.push("Source document ownership does not match the review run.");
    }
    const candidates = await tx.select({
      visibilityScope: chunkCandidates.visibilityScope,
      tenantId: chunkCandidates.tenantId,
      ownershipManifestId: chunkCandidates.ownershipManifestId,
      ownershipManifestVersion: chunkCandidates.ownershipManifestVersion,
    }).from(chunkCandidates).where(eq(chunkCandidates.ingestionRunId, runId));
    if (runOwnership && (
      candidates.length !== run.candidateChunkCount
      || candidates.some((candidate) => !ownershipMatches(candidate, runOwnership!))
    )) {
      reasons.push("Candidate ownership does not match the review run.");
    }
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
    if (run.status !== "staged") {
      throw new Error("Only a fully staged review run can be published.");
    }
    const ownership = classifiedOwnershipFromRecord(run);
    const source = await lockReviewSource(tx, run.sourceType, run.sourceDocumentId);
    if (!source) throw new Error("Typed publication source document not found.");
    if (!ownershipMatches(source, ownership)) {
      throw new Error("Source document ownership does not match the staged review run.");
    }
    if (run.reviewPurpose === "content" && source.fileHash !== run.fileHash) {
      throw new Error("Source document changed after review staging.");
    }
    const candidates = await tx.select({
      text: chunkCandidates.text,
      metadata: chunkCandidates.metadata,
      visibilityScope: chunkCandidates.visibilityScope,
      tenantId: chunkCandidates.tenantId,
      ownershipManifestId: chunkCandidates.ownershipManifestId,
      ownershipManifestVersion: chunkCandidates.ownershipManifestVersion,
    }).from(chunkCandidates).where(eq(chunkCandidates.ingestionRunId, runId));
    if (candidates.length !== run.candidateChunkCount
      || candidates.some((candidate) => !ownershipMatches(candidate, ownership))) {
      throw new Error("Candidate ownership does not match the staged review run.");
    }
    await assertFaqDuplicateDisposition(tx, run.sourceDocumentId, candidates);

    if (run.sourceType === "pdf") {
      const staged = await tx.select({
        id: chunks.id,
        knowledgeDomain: chunks.knowledgeDomain,
        sourceCollection: chunks.sourceCollection,
        visibilityScope: chunks.visibilityScope,
        tenantId: chunks.tenantId,
        ownershipManifestId: chunks.ownershipManifestId,
        ownershipManifestVersion: chunks.ownershipManifestVersion,
      }).from(chunks).where(and(
        eq(chunks.ingestionRunId, runId),
        eq(chunks.publicationStatus, "staged"),
      ));
      if (staged.length !== run.candidateChunkCount) {
        throw new Error("Staged PDF vector count does not match the approved candidate count.");
      }
      if (staged.some((chunk) => !ownershipMatches(chunk, ownership))) {
        throw new Error("Staged PDF chunk ownership does not match the approved review run.");
      }
      await tx.update(chunks).set({ publicationStatus: "published" })
        .where(eq(chunks.ingestionRunId, runId));
      const expectedLexicalCount = staged.filter(hasLexicalSearchDocument).length;
      const [lexical] = await tx.select({
        count: sql<number>`count(*)::int`,
      }).from(chunkSearchDocuments).innerJoin(
        chunks,
        eq(chunkSearchDocuments.chunkId, chunks.id),
      ).where(eq(chunks.ingestionRunId, runId));
      if ((lexical?.count ?? 0) !== expectedLexicalCount) {
        throw new Error("Staged PDF lexical count does not match the intended published version.");
      }
      await tx.update(chunks).set({ publicationStatus: "retired" }).where(and(
        eq(chunks.documentId, run.sourceDocumentId),
        eq(chunks.publicationStatus, "published"),
        or(isNull(chunks.ingestionRunId), ne(chunks.ingestionRunId, runId)),
      ));
      await tx.update(documents).set({
        status: "completed",
        chunkCount: run.candidateChunkCount,
        updatedAt: new Date(),
      }).where(eq(documents.id, run.sourceDocumentId));
    } else {
      const staged = await tx.select({
        id: htmlChunks.id,
        knowledgeDomain: htmlChunks.knowledgeDomain,
        sourceCollection: htmlChunks.sourceCollection,
        visibilityScope: htmlChunks.visibilityScope,
        tenantId: htmlChunks.tenantId,
        ownershipManifestId: htmlChunks.ownershipManifestId,
        ownershipManifestVersion: htmlChunks.ownershipManifestVersion,
      }).from(htmlChunks).where(and(
        eq(htmlChunks.ingestionRunId, runId),
        eq(htmlChunks.publicationStatus, "staged"),
      ));
      if (staged.length !== run.candidateChunkCount) {
        throw new Error("Staged HTML vector count does not match the approved candidate count.");
      }
      if (staged.some((chunk) => !ownershipMatches(chunk, ownership))) {
        throw new Error("Staged HTML chunk ownership does not match the approved review run.");
      }
      await tx.update(htmlChunks).set({ publicationStatus: "published" })
        .where(eq(htmlChunks.ingestionRunId, runId));
      const expectedLexicalCount = staged.filter(hasLexicalSearchDocument).length;
      const [lexical] = await tx.select({
        count: sql<number>`count(*)::int`,
      }).from(htmlChunkSearchDocuments).innerJoin(
        htmlChunks,
        eq(htmlChunkSearchDocuments.chunkId, htmlChunks.id),
      ).where(eq(htmlChunks.ingestionRunId, runId));
      if ((lexical?.count ?? 0) !== expectedLexicalCount) {
        throw new Error("Staged HTML lexical count does not match the intended published version.");
      }
      await tx.update(htmlChunks).set({ publicationStatus: "retired" }).where(and(
        eq(htmlChunks.documentId, run.sourceDocumentId),
        eq(htmlChunks.publicationStatus, "published"),
        or(isNull(htmlChunks.ingestionRunId), ne(htmlChunks.ingestionRunId, runId)),
      ));
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
