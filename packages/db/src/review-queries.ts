import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type {
  CandidateChunkMetadata,
  ClassifiedKnowledgeOwnership,
  ChunkFlagStatus,
  KnowledgeOwnershipRecord,
  ReviewPurpose,
  ReviewSourceType,
} from "@mf-rag/types";
import {
  assertClassifiedKnowledgeOwnership,
  classifiedKnowledgeOwnershipFromRecord,
  hasSameKnowledgeOwnership,
  isCuratedFaqMetadata,
} from "@mf-rag/types";

import type { Database } from "./client.ts";
import {
  accessScopes,
  chunkCandidates,
  chunkCandidateEdits,
  chunkFlags,
  chunkSearchDocuments,
  chunks,
  documentPublicationGenerations,
  documentVersions,
  documents,
  htmlChunks,
  htmlChunkSearchDocuments,
  htmlDocuments,
  ingestionRuns,
  pipelineRuns,
  sourceDocuments,
  sourceRegistryRevisions,
  sources,
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
  /** Scheduled pipeline lineage. Legacy/manual review staging leaves both fields unset. */
  documentVersionId?: string;
  configRevisionId?: string;
  pipelineRunId?: string;
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

export interface ScheduledReviewRiskContext {
  readonly run: IngestionRun;
  readonly isFirstVersion: boolean;
  readonly previousPublication: typeof documentPublicationGenerations.$inferSelect | null;
}

export interface PersistScheduledRiskDecisionInput {
  readonly runId: string;
  readonly policyVersion: string;
  readonly classification: "low" | "elevated";
  readonly route: "system_approve" | "human_review";
  readonly reasonCodes: readonly string[];
  readonly evidence: NonNullable<IngestionRun["riskEvidence"]>;
  readonly actor: string;
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

type OwnershipRecord = KnowledgeOwnershipRecord;

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

async function lockReviewSource(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  input: Pick<StageInspectionReviewInput,
    "sourceType" | "sourceDocumentId" | "documentVersionId" | "configRevisionId" | "pipelineRunId" | "ownership"
  >,
): Promise<(OwnershipRecord & { fileHash: string }) | undefined> {
  const scheduledFields = [input.documentVersionId, input.configRevisionId, input.pipelineRunId];
  if (scheduledFields.some(Boolean)) {
    if (input.sourceType !== "pdf" || scheduledFields.some((value) => !value)) {
      throw new Error("Scheduled PDF review requires pipeline-run, document-version, and configuration-revision lineage.");
    }
    await tx.execute(sql`
      SELECT ${documentVersions.id}
      FROM ${documentVersions}
      WHERE ${documentVersions.id} = ${input.documentVersionId}
      FOR UPDATE
    `);
    const [row] = await tx.select({
      version: documentVersions,
      document: sourceDocuments,
      source: sources,
      scope: accessScopes,
      pipelineRun: pipelineRuns,
      revision: sourceRegistryRevisions,
    }).from(documentVersions)
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, documentVersions.sourceDocumentId))
      .innerJoin(sources, eq(sources.id, documentVersions.sourceId))
      .innerJoin(accessScopes, eq(accessScopes.id, documentVersions.accessScopeId))
      .innerJoin(pipelineRuns, eq(pipelineRuns.id, input.pipelineRunId!))
      .innerJoin(sourceRegistryRevisions, eq(sourceRegistryRevisions.id, pipelineRuns.configRevisionId))
      .where(and(
        eq(documentVersions.id, input.documentVersionId!),
        eq(sourceDocuments.id, input.sourceDocumentId),
        eq(pipelineRuns.documentVersionId, documentVersions.id),
        eq(pipelineRuns.sourceId, documentVersions.sourceId),
        eq(pipelineRuns.accessScopeId, documentVersions.accessScopeId),
        eq(pipelineRuns.configRevisionId, input.configRevisionId!),
      )).limit(1);
    if (!row) return undefined;
    const desiredScope = row.revision.desiredState.accessScopes.find((scope) =>
      String(scope.accessScopeKey) === row.scope.accessScopeKey);
    const desiredSource = desiredScope?.sources.find((source) =>
      String(source.sourceKey) === row.source.sourceKey);
    if (!desiredScope || !desiredSource) {
      throw new Error("Scheduled review ownership is absent from the immutable registry revision.");
    }
    return {
      fileHash: row.version.contentSha256,
      visibilityScope: "TENANT",
      tenantId: String(desiredScope.externalCode),
      ownershipManifestId: `source-registry:${row.revision.id}`,
      ownershipManifestVersion: 1,
    };
  }
  if (input.sourceType === "pdf") {
    await tx.execute(sql`
      SELECT ${documents.id}
      FROM ${documents}
      WHERE ${documents.id} = ${input.sourceDocumentId}
      FOR UPDATE
    `);
    const [source] = await tx.select({
      fileHash: documents.fileHash,
      visibilityScope: documents.visibilityScope,
      tenantId: documents.tenantId,
      ownershipManifestId: documents.ownershipManifestId,
      ownershipManifestVersion: documents.ownershipManifestVersion,
    }).from(documents).where(eq(documents.id, input.sourceDocumentId));
    return source;
  }
  await tx.execute(sql`
    SELECT ${htmlDocuments.id}
    FROM ${htmlDocuments}
    WHERE ${htmlDocuments.id} = ${input.sourceDocumentId}
    FOR UPDATE
  `);
  const [source] = await tx.select({
    fileHash: htmlDocuments.fileHash,
    visibilityScope: htmlDocuments.visibilityScope,
    tenantId: htmlDocuments.tenantId,
    ownershipManifestId: htmlDocuments.ownershipManifestId,
    ownershipManifestVersion: htmlDocuments.ownershipManifestVersion,
  }).from(htmlDocuments).where(eq(htmlDocuments.id, input.sourceDocumentId));
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
    const source = await lockReviewSource(tx, input);
    if (!source) throw new Error("Typed review source document not found.");
    const sourceOwnership = classifiedKnowledgeOwnershipFromRecord(source);
    if (!hasSameKnowledgeOwnership(sourceOwnership, input.ownership)) {
      throw new Error("Trusted ownership does not match the source document ownership.");
    }
    if ((input.reviewPurpose ?? "content") === "content" && source.fileHash !== input.fileHash) {
      throw new Error("Source document changed before review staging.");
    }

    if (input.documentVersionId) {
      const [compatible] = await tx.select().from(ingestionRuns).where(and(
        eq(ingestionRuns.documentVersionId, input.documentVersionId),
        eq(ingestionRuns.configRevisionId, input.configRevisionId!),
        eq(ingestionRuns.parserVersion, input.parserVersion),
        eq(ingestionRuns.chunkerVersion, input.chunkerVersion),
        eq(ingestionRuns.inspectorVersion, input.report.inspectorVersion),
      )).limit(1);
      if (compatible) {
        const persistedCandidates = await tx.select({
          chunkIndex: chunkCandidates.chunkIndex,
          contentHash: chunkCandidates.contentHash,
        }).from(chunkCandidates)
          .where(eq(chunkCandidates.ingestionRunId, compatible.id))
          .orderBy(asc(chunkCandidates.chunkIndex));
        const proposedCandidates = [...input.candidates]
          .sort((left, right) => left.chunkIndex - right.chunkIndex);
        const candidateContentMatches = persistedCandidates.length === input.candidates.length
          && persistedCandidates.every((candidate, index) => {
            const proposed = proposedCandidates[index];
            return proposed?.chunkIndex === candidate.chunkIndex
              && proposed.contentHash === candidate.contentHash;
          });
        if (compatible.sourceDocumentId !== input.sourceDocumentId
          || compatible.fileHash !== input.fileHash
          || compatible.candidateChunkCount !== input.candidates.length
          || compatible.inspectedChunkCount !== input.report.inspectedChunkCount
          || compatible.criticalCount !== input.report.criticalCount
          || compatible.blockingCount !== input.report.blockingCount
          || !candidateContentMatches
          || !hasSameKnowledgeOwnership(compatible, input.ownership)) {
          throw new Error("Compatible scheduled review lineage conflicts with the staged candidate contract.");
        }
        return compatible;
      }
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
      documentVersionId: input.documentVersionId ?? null,
      pipelineRunId: input.pipelineRunId ?? null,
      configRevisionId: input.configRevisionId ?? null,
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

export async function getScheduledReviewRiskContext(
  db: Database,
  runId: string,
): Promise<ScheduledReviewRiskContext> {
  const [run] = await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, runId));
  if (!run) throw new Error("Review run not found.");
  if (!run.documentVersionId || !run.pipelineRunId || !run.configRevisionId) {
    throw new Error("Scheduled risk routing requires exact document, pipeline, and configuration lineage.");
  }
  const [previousPublication] = await db.select().from(documentPublicationGenerations).where(and(
    eq(documentPublicationGenerations.sourceDocumentId, run.sourceDocumentId),
    eq(documentPublicationGenerations.status, "published"),
  )).limit(1);
  return {
    run,
    isFirstVersion: !previousPublication,
    previousPublication: previousPublication ?? null,
  };
}

/** Persist one immutable policy decision and either auto-approve or pause for a person. */
export async function persistScheduledRiskDecision(
  db: Database,
  input: PersistScheduledRiskDecisionInput,
): Promise<IngestionRun> {
  if (!input.policyVersion.trim() || !input.actor.trim() || input.reasonCodes.length === 0) {
    throw new Error("Risk decision requires policy version, actor, and reason codes.");
  }
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(ingestionRuns)
      .where(eq(ingestionRuns.id, input.runId)).limit(1).for("update");
    if (!run) throw new Error("Review run not found.");
    if (!run.documentVersionId || !run.pipelineRunId || !run.configRevisionId) {
      throw new Error("Scheduled risk decision requires exact lineage.");
    }
    if (run.riskPolicyVersion) {
      const same = run.riskPolicyVersion === input.policyVersion
        && run.riskClassification === input.classification
        && run.riskRoute === input.route
        && run.riskActor === input.actor
        && JSON.stringify(run.riskReasonCodes) === JSON.stringify(input.reasonCodes)
        && JSON.stringify(run.riskEvidence) === JSON.stringify(input.evidence);
      if (!same) throw new Error("Review run already has a different risk decision.");
      return run;
    }
    if (run.status !== "review_ready") throw new Error("Only a review-ready run can be risk routed.");
    const [lineage] = await tx.select({
      pipeline: pipelineRuns,
      version: documentVersions,
      document: sourceDocuments,
      scope: accessScopes,
      source: sources,
    }).from(pipelineRuns)
      .innerJoin(documentVersions, eq(documentVersions.id, pipelineRuns.documentVersionId))
      .innerJoin(sourceDocuments, eq(sourceDocuments.id, documentVersions.sourceDocumentId))
      .innerJoin(accessScopes, eq(accessScopes.id, pipelineRuns.accessScopeId))
      .innerJoin(sources, eq(sources.id, pipelineRuns.sourceId))
      .where(and(
        eq(pipelineRuns.id, run.pipelineRunId),
        eq(documentVersions.id, run.documentVersionId),
        eq(sourceDocuments.id, run.sourceDocumentId),
        eq(pipelineRuns.configRevisionId, run.configRevisionId),
      )).limit(1);
    if (!lineage) throw new Error("Scheduled risk lineage no longer matches the review run.");
    if (lineage.scope.emergencyFrozenAt || lineage.source.emergencyFrozenAt) {
      throw new Error("Emergency freeze prevents risk decision resume.");
    }
    const [flagCounts] = await tx.select({
      blocking: sql<number>`count(*) filter (where ${chunkFlags.status} = 'open' and ${chunkFlags.blocksApproval} = true)::int`,
      warning: sql<number>`count(*) filter (where ${chunkFlags.status} = 'open' and ${chunkFlags.severity} = 'warning')::int`,
    }).from(chunkFlags).where(eq(chunkFlags.ingestionRunId, run.id));
    const [previousPublication] = await tx.select().from(documentPublicationGenerations).where(and(
      eq(documentPublicationGenerations.sourceDocumentId, run.sourceDocumentId),
      eq(documentPublicationGenerations.status, "published"),
    )).limit(1).for("update");
    const expectedEvidence: NonNullable<IngestionRun["riskEvidence"]> = {
      isFirstVersion: !previousPublication,
      candidateChunkCount: run.candidateChunkCount,
      inspectedChunkCount: run.inspectedChunkCount,
      openBlockingCount: flagCounts?.blocking ?? 0,
      openWarningCount: flagCounts?.warning ?? 0,
      extractionAnomaly: run.criticalCount > 0,
      ownershipDrift: Boolean(previousPublication) && (
        previousPublication!.visibilityScope !== run.visibilityScope
        || previousPublication!.tenantId !== run.tenantId
        || previousPublication!.ownershipManifestId !== run.ownershipManifestId
        || previousPublication!.ownershipManifestVersion !== run.ownershipManifestVersion
      ),
      configRevisionDrift: Boolean(previousPublication)
        && previousPublication!.configRevisionId !== run.configRevisionId,
      parserVersionDrift: Boolean(previousPublication)
        && previousPublication!.parserVersion !== run.parserVersion,
      chunkerVersionDrift: Boolean(previousPublication)
        && previousPublication!.chunkerVersion !== run.chunkerVersion,
      inspectorVersionDrift: Boolean(previousPublication)
        && previousPublication!.inspectorVersion !== run.inspectorVersion,
    };
    if (Object.entries(expectedEvidence).some(([key, value]) =>
      input.evidence[key as keyof typeof expectedEvidence] !== value)) {
      throw new Error("Risk decision evidence does not match the current inspected review state.");
    }
    if (input.route === "system_approve") {
      const unsafe = input.classification !== "low"
        || input.evidence.isFirstVersion
        || input.evidence.candidateChunkCount <= 0
        || input.evidence.inspectedChunkCount !== input.evidence.candidateChunkCount
        || input.evidence.openBlockingCount > 0
        || input.evidence.openWarningCount > 0
        || input.evidence.extractionAnomaly
        || input.evidence.ownershipDrift
        || input.evidence.configRevisionDrift
        || input.evidence.parserVersionDrift
        || input.evidence.chunkerVersionDrift
        || input.evidence.inspectorVersionDrift;
      if (unsafe) throw new Error("System approval is allowed only for a clean established update.");
    }
    const now = new Date();
    const [updated] = await tx.update(ingestionRuns).set({
      status: input.route === "system_approve" ? "approved" : "review_ready",
      reviewer: input.route === "system_approve" ? input.actor : null,
      reviewNote: input.route === "system_approve" ? input.reasonCodes.join(",") : null,
      reviewedAt: input.route === "system_approve" ? now : null,
      riskPolicyVersion: input.policyVersion,
      riskClassification: input.classification,
      riskRoute: input.route,
      riskReasonCodes: [...input.reasonCodes],
      riskEvidence: input.evidence,
      riskActor: input.actor,
      riskDecidedAt: now,
      updatedAt: now,
    }).where(and(
      eq(ingestionRuns.id, run.id),
      isNull(ingestionRuns.riskPolicyVersion),
    )).returning();
    if (!updated) throw new Error("Risk decision was concurrently changed.");
    await tx.execute(sql`
      UPDATE ${ingestionRuns}
      SET
        risk_reason_codes = CASE WHEN jsonb_typeof(${ingestionRuns.riskReasonCodes}) = 'string'
          THEN (${ingestionRuns.riskReasonCodes} #>> '{}')::jsonb ELSE ${ingestionRuns.riskReasonCodes} END,
        risk_evidence = CASE WHEN jsonb_typeof(${ingestionRuns.riskEvidence}) = 'string'
          THEN (${ingestionRuns.riskEvidence} #>> '{}')::jsonb ELSE ${ingestionRuns.riskEvidence} END
      WHERE ${ingestionRuns.id} = ${run.id}
    `);
    await tx.update(pipelineRuns).set({
      pausedAt: input.route === "human_review" ? now : null,
      updatedAt: now,
    }).where(and(eq(pipelineRuns.id, run.pipelineRunId), eq(pipelineRuns.status, "active")));
    await tx.insert(reviewEvents).values({
      ingestionRunId: run.id,
      eventType: input.route === "system_approve" ? "risk_system_approved" : "risk_human_required",
      actor: input.actor,
      details: { policyVersion: input.policyVersion, classification: input.classification, reasonCodes: input.reasonCodes },
    });
    return updated;
  });
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
      runOwnership = classifiedKnowledgeOwnershipFromRecord(run);
    } catch {
      reasons.push("Review run ownership is missing or unclassified.");
    }
    const source = runOwnership ? await lockReviewSource(tx, {
      sourceType: run.sourceType,
      sourceDocumentId: run.sourceDocumentId,
      documentVersionId: run.documentVersionId ?? undefined,
      pipelineRunId: run.pipelineRunId ?? undefined,
      configRevisionId: run.configRevisionId ?? undefined,
      ownership: runOwnership,
    }) : undefined;
    if (!source) {
      reasons.push("Typed review source document not found.");
    } else if (runOwnership && !hasSameKnowledgeOwnership(source, runOwnership)) {
      reasons.push("Source document ownership does not match the review run.");
    }
    if (run.documentVersionId && run.pipelineRunId && run.configRevisionId) {
      const [scheduled] = await tx.select({
        currentVersionId: sourceDocuments.currentVersionId,
        pipelineConfigRevisionId: pipelineRuns.configRevisionId,
        pipelineStatus: pipelineRuns.status,
        scopeFrozenAt: accessScopes.emergencyFrozenAt,
        sourceFrozenAt: sources.emergencyFrozenAt,
      }).from(pipelineRuns)
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, run.sourceDocumentId))
        .innerJoin(accessScopes, eq(accessScopes.id, pipelineRuns.accessScopeId))
        .innerJoin(sources, eq(sources.id, pipelineRuns.sourceId))
        .where(and(
          eq(pipelineRuns.id, run.pipelineRunId),
          eq(pipelineRuns.documentVersionId, run.documentVersionId),
        )).limit(1);
      if (!scheduled || scheduled.pipelineStatus !== "active") {
        reasons.push("Scheduled pipeline run is no longer active.");
      } else {
        if (scheduled.currentVersionId !== run.documentVersionId) {
          reasons.push("A newer document version superseded this review.");
        }
        if (scheduled.pipelineConfigRevisionId !== run.configRevisionId) {
          reasons.push("Pipeline configuration lineage changed after review staging.");
        }
        if (scheduled.scopeFrozenAt || scheduled.sourceFrozenAt) {
          reasons.push("Emergency freeze prevents review resume.");
        }
      }
      if (run.riskRoute !== "human_review" || !run.riskPolicyVersion || !run.riskActor) {
        reasons.push("Scheduled human review has no exact risk-policy decision.");
      }
    }
    const candidates = await tx.select({
      visibilityScope: chunkCandidates.visibilityScope,
      tenantId: chunkCandidates.tenantId,
      ownershipManifestId: chunkCandidates.ownershipManifestId,
      ownershipManifestVersion: chunkCandidates.ownershipManifestVersion,
    }).from(chunkCandidates).where(eq(chunkCandidates.ingestionRunId, runId));
    if (runOwnership && (
      candidates.length !== run.candidateChunkCount
      || candidates.some((candidate) => !hasSameKnowledgeOwnership(candidate, runOwnership!))
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
    if (approved.pipelineRunId) {
      await tx.update(pipelineRuns).set({ pausedAt: null, updatedAt: new Date() }).where(and(
        eq(pipelineRuns.id, approved.pipelineRunId),
        eq(pipelineRuns.status, "active"),
      ));
    }
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
    const now = new Date();
    const [run] = await tx.update(ingestionRuns).set({
      status: "rejected",
      reviewer,
      reviewNote: note,
      reviewedAt: now,
      updatedAt: now,
    }).where(and(
      eq(ingestionRuns.id, runId),
      eq(ingestionRuns.status, "review_ready"),
    )).returning();
    if (!run) throw new Error("Review run not found.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: runId,
      eventType: "run_rejected",
      actor: reviewer,
      note,
    });
    if (run.pipelineRunId) {
      await tx.update(pipelineRuns).set({
        status: "failed",
        pausedAt: null,
        completedAt: now,
        updatedAt: now,
      }).where(and(eq(pipelineRuns.id, run.pipelineRunId), eq(pipelineRuns.status, "active")));
    }
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
    const ownership = classifiedKnowledgeOwnershipFromRecord(run);
    const source = await lockReviewSource(tx, {
      sourceType: run.sourceType,
      sourceDocumentId: run.sourceDocumentId,
      documentVersionId: run.documentVersionId ?? undefined,
      pipelineRunId: run.pipelineRunId ?? undefined,
      configRevisionId: run.configRevisionId ?? undefined,
      ownership,
    });
    if (!source) throw new Error("Typed publication source document not found.");
    if (!hasSameKnowledgeOwnership(source, ownership)) {
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
      || candidates.some((candidate) => !hasSameKnowledgeOwnership(candidate, ownership))) {
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
      if (staged.some((chunk) => !hasSameKnowledgeOwnership(chunk, ownership))) {
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
      if (staged.some((chunk) => !hasSameKnowledgeOwnership(chunk, ownership))) {
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
