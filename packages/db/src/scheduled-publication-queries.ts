import { and, eq, ne, sql } from "drizzle-orm";
import type { CandidateChunkMetadata, ClassifiedKnowledgeOwnership } from "@mf-rag/types";

import type { Database } from "./client.ts";
import {
  accessScopes,
  chunkCandidates,
  documentPublicationChunks,
  documentPublicationGenerations,
  documentVersions,
  ingestionRuns,
  pipelineRuns,
  reviewEvents,
  sourceDocuments,
  sources,
} from "./schema.ts";

export interface ScheduledPublicationChunkInput {
  readonly embedding: number[];
  readonly text: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly pageNumbers: number[];
  readonly sectionHeader: string | null;
  readonly hasTable: boolean;
  readonly metadata: CandidateChunkMetadata;
}

export interface StageScheduledPublicationInput {
  readonly ingestionRunId: string;
  readonly chunks: readonly ScheduledPublicationChunkInput[];
}

export type ScheduledCutoverResult =
  | { readonly status: "published"; readonly generationId: string }
  | { readonly status: "stale" | "frozen"; readonly generationId: string };

export interface ReactivateScheduledPublicationInput {
  readonly sourceDocumentId: string;
  readonly currentGenerationId: string;
  readonly targetGenerationId: string;
  readonly expectedAccessScopeId: string;
  readonly expectedSourceId: string;
  readonly actor: string;
  readonly incidentId: string;
}

function ownershipOf(run: typeof ingestionRuns.$inferSelect): ClassifiedKnowledgeOwnership {
  if (run.visibilityScope === "GLOBAL" && run.tenantId === null
    && run.ownershipManifestId && run.ownershipManifestVersion) {
    return {
      visibilityScope: "GLOBAL",
      tenantId: null,
      ownershipManifestId: run.ownershipManifestId,
      ownershipManifestVersion: run.ownershipManifestVersion,
    };
  }
  if (run.visibilityScope === "TENANT" && run.tenantId
    && run.ownershipManifestId && run.ownershipManifestVersion) {
    return {
      visibilityScope: "TENANT",
      tenantId: run.tenantId,
      ownershipManifestId: run.ownershipManifestId,
      ownershipManifestVersion: run.ownershipManifestVersion,
    };
  }
  throw new Error("Scheduled publication ownership is missing or unclassified.");
}

async function lockScheduledLineage(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  ingestionRunId: string,
) {
  const [run] = await tx.select().from(ingestionRuns)
    .where(eq(ingestionRuns.id, ingestionRunId)).limit(1).for("update");
  if (!run?.documentVersionId || !run.pipelineRunId || !run.configRevisionId) {
    throw new Error("Scheduled publication requires exact review lineage.");
  }
  await tx.execute(sql`
    SELECT ${sourceDocuments.id}
    FROM ${sourceDocuments}
    WHERE ${sourceDocuments.id} = ${run.sourceDocumentId}
    FOR UPDATE
  `);
  const [lineage] = await tx.select({
    version: documentVersions,
    document: sourceDocuments,
    pipeline: pipelineRuns,
    scope: accessScopes,
    source: sources,
  }).from(documentVersions)
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, documentVersions.sourceDocumentId))
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, run.pipelineRunId))
    .innerJoin(accessScopes, eq(accessScopes.id, pipelineRuns.accessScopeId))
    .innerJoin(sources, eq(sources.id, pipelineRuns.sourceId))
    .where(and(
      eq(documentVersions.id, run.documentVersionId),
      eq(sourceDocuments.id, run.sourceDocumentId),
      eq(pipelineRuns.documentVersionId, run.documentVersionId),
      eq(pipelineRuns.configRevisionId, run.configRevisionId),
    )).limit(1);
  if (!lineage) throw new Error("Scheduled publication lineage does not match the approved review.");
  return { run, lineage };
}

/** Gate checked before embeddings are requested. */
export async function assertScheduledPublicationReady(
  db: Database,
  ingestionRunId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { run, lineage } = await lockScheduledLineage(tx, ingestionRunId);
    if (!["approved", "embedding", "staged", "failed"].includes(run.status)) {
      throw new Error("Scheduled review is not approved.");
    }
    if (!run.riskPolicyVersion || !run.riskActor || !run.riskRoute || !run.riskEvidence) {
      throw new Error("Scheduled review is missing its risk decision lineage.");
    }
    if (lineage.document.currentVersionId !== run.documentVersionId) {
      throw new Error("Scheduled review approval is stale.");
    }
    if (lineage.scope.emergencyFrozenAt || lineage.source.emergencyFrozenAt) {
      throw new Error("Emergency freeze prevents scheduled embedding.");
    }
  });
}

/** Replace only an unpublished generation for an idempotent retry. */
export async function stageScheduledPublicationGeneration(
  db: Database,
  input: StageScheduledPublicationInput,
): Promise<typeof documentPublicationGenerations.$inferSelect> {
  return db.transaction(async (tx) => {
    const { run, lineage } = await lockScheduledLineage(tx, input.ingestionRunId);
    if (run.status !== "embedding" || !run.riskPolicyVersion || !run.riskActor) {
      throw new Error("Only an approved, risk-routed scheduled review can stage vectors.");
    }
    if (lineage.document.currentVersionId !== run.documentVersionId) {
      throw new Error("Scheduled review became stale before vector staging.");
    }
    if (lineage.scope.emergencyFrozenAt || lineage.source.emergencyFrozenAt) {
      throw new Error("Emergency freeze prevents scheduled vector staging.");
    }
    if (input.chunks.length !== run.candidateChunkCount) {
      throw new Error("Scheduled vector count does not match the approved candidate count.");
    }
    const ownership = ownershipOf(run);
    const [existing] = await tx.select().from(documentPublicationGenerations).where(
      eq(documentPublicationGenerations.ingestionRunId, run.id),
    ).limit(1).for("update");
    if (existing?.status === "published") return existing;
    if (existing) {
      await tx.delete(documentPublicationChunks).where(eq(documentPublicationChunks.generationId, existing.id));
      await tx.update(documentPublicationGenerations).set({
        status: "staged",
        staleAt: null,
        stagedAt: new Date(),
      }).where(eq(documentPublicationGenerations.id, existing.id));
    }
    const generation = existing ?? (await tx.insert(documentPublicationGenerations).values({
      sourceDocumentId: run.sourceDocumentId,
      documentVersionId: run.documentVersionId!,
      ingestionRunId: run.id,
      pipelineRunId: run.pipelineRunId!,
      accessScopeId: lineage.pipeline.accessScopeId,
      sourceId: lineage.pipeline.sourceId,
      configRevisionId: run.configRevisionId!,
      riskPolicyVersion: run.riskPolicyVersion,
      riskDecisionActor: run.riskActor,
      parserVersion: run.parserVersion,
      chunkerVersion: run.chunkerVersion,
      inspectorVersion: run.inspectorVersion,
      ...ownership,
    }).returning())[0];
    if (!generation) throw new Error("Failed to stage scheduled publication generation.");
    if (input.chunks.length > 0) {
      await tx.insert(documentPublicationChunks).values(input.chunks.map((chunk) => ({
        generationId: generation.id,
        embedding: chunk.embedding,
        text: chunk.text,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        pageNumbers: chunk.pageNumbers,
        sectionHeader: chunk.sectionHeader,
        hasTable: chunk.hasTable,
        retrievalMetadata: chunk.metadata,
        ...ownership,
      })));
      await tx.execute(sql`
        UPDATE ${documentPublicationChunks}
        SET
          page_numbers = CASE WHEN jsonb_typeof(${documentPublicationChunks.pageNumbers}) = 'string'
            THEN (${documentPublicationChunks.pageNumbers} #>> '{}')::jsonb ELSE ${documentPublicationChunks.pageNumbers} END,
          retrieval_metadata = CASE WHEN jsonb_typeof(${documentPublicationChunks.retrievalMetadata}) = 'string'
            THEN (${documentPublicationChunks.retrievalMetadata} #>> '{}')::jsonb ELSE ${documentPublicationChunks.retrievalMetadata} END
        WHERE ${documentPublicationChunks.generationId} = ${generation.id}
      `);
    }
    return generation;
  });
}

/** One version-fenced transaction exposes the new generation and retires the old one. */
export async function cutoverScheduledPublicationGeneration(
  db: Database,
  ingestionRunId: string,
  actor: string,
): Promise<ScheduledCutoverResult> {
  return db.transaction(async (tx) => {
    const { run, lineage } = await lockScheduledLineage(tx, ingestionRunId);
    const [generation] = await tx.select().from(documentPublicationGenerations).where(
      eq(documentPublicationGenerations.ingestionRunId, run.id),
    ).limit(1).for("update");
    if (!generation) throw new Error("Scheduled publication generation was not staged.");
    if (generation.status === "published") return { status: "published", generationId: generation.id };
    if (generation.status === "stale" || generation.status === "retired") {
      return { status: "stale", generationId: generation.id };
    }
    if (lineage.scope.emergencyFrozenAt || lineage.source.emergencyFrozenAt) {
      return { status: "frozen", generationId: generation.id };
    }
    const exactApproval = run.status === "staged"
      && run.documentVersionId === generation.documentVersionId
      && run.pipelineRunId === generation.pipelineRunId
      && run.configRevisionId === generation.configRevisionId
      && run.riskPolicyVersion === generation.riskPolicyVersion
      && run.riskActor === generation.riskDecisionActor
      && Boolean(run.reviewedAt)
      && Boolean(run.riskDecidedAt)
      && Boolean(run.riskReasonCodes?.length)
      && Boolean(run.riskEvidence)
      && (
        (run.riskRoute === "system_approve" && run.riskClassification === "low")
        || (run.riskRoute === "human_review" && run.riskClassification === "elevated")
      )
      && lineage.pipeline.status === "active"
      && lineage.document.currentVersionId === run.documentVersionId
      && lineage.scope.configRevisionId === run.configRevisionId
      && lineage.source.configRevisionId === run.configRevisionId
      && generation.sourceDocumentId === run.sourceDocumentId
      && generation.accessScopeId === lineage.pipeline.accessScopeId
      && generation.sourceId === lineage.pipeline.sourceId
      && generation.parserVersion === run.parserVersion
      && generation.chunkerVersion === run.chunkerVersion
      && generation.inspectorVersion === run.inspectorVersion
      && generation.visibilityScope === run.visibilityScope
      && generation.tenantId === run.tenantId
      && generation.ownershipManifestId === run.ownershipManifestId
      && generation.ownershipManifestVersion === run.ownershipManifestVersion;
    if (!exactApproval) {
      await tx.update(documentPublicationGenerations).set({ status: "stale", staleAt: new Date() })
        .where(eq(documentPublicationGenerations.id, generation.id));
      return { status: "stale", generationId: generation.id };
    }
    const [chunkCount] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(documentPublicationChunks)
      .where(eq(documentPublicationChunks.generationId, generation.id));
    if ((chunkCount?.count ?? 0) !== run.candidateChunkCount) {
      throw new Error("Scheduled generation is only partially staged.");
    }
    const [candidateCounts] = await tx.select({
      total: sql<number>`count(*)::int`,
      ownershipMismatches: sql<number>`count(*) filter (where
        ${chunkCandidates.visibilityScope} is distinct from ${run.visibilityScope}
        or ${chunkCandidates.tenantId} is distinct from ${run.tenantId}
        or ${chunkCandidates.ownershipManifestId} is distinct from ${run.ownershipManifestId}
        or ${chunkCandidates.ownershipManifestVersion} is distinct from ${run.ownershipManifestVersion}
      )::int`,
    }).from(chunkCandidates).where(eq(chunkCandidates.ingestionRunId, run.id));
    if ((candidateCounts?.total ?? 0) !== run.candidateChunkCount
      || (candidateCounts?.ownershipMismatches ?? 0) > 0) {
      throw new Error("Approved scheduled candidate set changed before cutover.");
    }
    const now = new Date();
    await tx.update(documentPublicationGenerations).set({ status: "retired", retiredAt: now })
      .where(and(
        eq(documentPublicationGenerations.sourceDocumentId, run.sourceDocumentId),
        eq(documentPublicationGenerations.status, "published"),
        ne(documentPublicationGenerations.id, generation.id),
      ));
    await tx.update(documentPublicationGenerations).set({ status: "published", publishedAt: now })
      .where(and(
        eq(documentPublicationGenerations.id, generation.id),
        eq(documentPublicationGenerations.status, "staged"),
      ));
    await tx.update(ingestionRuns).set({ status: "published", updatedAt: now })
      .where(and(eq(ingestionRuns.id, run.id), eq(ingestionRuns.status, "staged")));
    await tx.update(pipelineRuns).set({ status: "succeeded", completedAt: now, updatedAt: now })
      .where(and(eq(pipelineRuns.id, run.pipelineRunId!), eq(pipelineRuns.status, "active")));
    await tx.insert(reviewEvents).values({
      ingestionRunId: run.id,
      eventType: "scheduled_generation_published",
      actor,
      details: { generationId: generation.id, documentVersionId: run.documentVersionId },
    });
    return { status: "published", generationId: generation.id };
  });
}

/** Incident-only rollback: atomically swap the published generation for one reviewed predecessor. */
export async function reactivateScheduledPublicationGeneration(
  db: Database,
  input: ReactivateScheduledPublicationInput,
): Promise<{ readonly generationId: string; readonly replacedGenerationId: string }> {
  if (!input.actor.trim() || !input.incidentId.trim()) {
    throw new Error("Prior-generation reactivation requires an actor and incident identifier.");
  }
  if (input.currentGenerationId === input.targetGenerationId) {
    throw new Error("Prior-generation reactivation requires distinct generation identifiers.");
  }
  return db.transaction(async (tx) => {
    const [document] = await tx.select().from(sourceDocuments).where(and(
      eq(sourceDocuments.id, input.sourceDocumentId),
      eq(sourceDocuments.accessScopeId, input.expectedAccessScopeId),
      eq(sourceDocuments.sourceId, input.expectedSourceId),
    )).limit(1).for("update");
    if (!document) throw new Error("Publication rollback ownership guard did not match the source document.");

    const generations = await tx.select().from(documentPublicationGenerations).where(and(
      eq(documentPublicationGenerations.sourceDocumentId, document.id),
      eq(documentPublicationGenerations.accessScopeId, document.accessScopeId),
      eq(documentPublicationGenerations.sourceId, document.sourceId),
    )).for("update");
    const current = generations.find((generation) => generation.id === input.currentGenerationId);
    const target = generations.find((generation) => generation.id === input.targetGenerationId);
    if (!current || current.status !== "published") {
      throw new Error("Expected incident generation is not the currently published generation.");
    }
    if (!target || target.status !== "retired") {
      throw new Error("Rollback target is not a retired generation for this logical document.");
    }
    if (target.visibilityScope !== current.visibilityScope
      || target.tenantId !== current.tenantId
      || target.ownershipManifestId !== current.ownershipManifestId
      || target.ownershipManifestVersion !== current.ownershipManifestVersion) {
      throw new Error("Rollback target ownership differs from the currently published generation.");
    }
    const now = new Date();
    const [retired] = await tx.update(documentPublicationGenerations).set({
      status: "retired",
      retiredAt: now,
    }).where(and(
      eq(documentPublicationGenerations.id, current.id),
      eq(documentPublicationGenerations.status, "published"),
    )).returning({ id: documentPublicationGenerations.id });
    const [reactivated] = await tx.update(documentPublicationGenerations).set({
      status: "published",
      publishedAt: now,
      retiredAt: null,
      staleAt: null,
    }).where(and(
      eq(documentPublicationGenerations.id, target.id),
      eq(documentPublicationGenerations.status, "retired"),
    )).returning({ id: documentPublicationGenerations.id });
    if (!retired || !reactivated) throw new Error("Publication rollback lost its generation fence.");
    await tx.insert(reviewEvents).values({
      ingestionRunId: target.ingestionRunId,
      eventType: "scheduled_generation_reactivated",
      actor: input.actor,
      details: {
        incidentId: input.incidentId,
        sourceDocumentId: document.id,
        replacedGenerationId: current.id,
        reactivatedGenerationId: target.id,
      },
    });
    return { generationId: target.id, replacedGenerationId: current.id };
  });
}
