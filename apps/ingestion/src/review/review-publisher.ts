import { createHash } from "node:crypto";

import {
  and,
  chunks,
  db,
  eq,
  getReviewRunDetail,
  htmlChunks,
  ingestionRuns,
  markReviewRunFailed,
  publishReviewRun,
  reviewEvents,
  sql,
  updateReviewRunStatus,
  type Database,
  type IngestionRun,
} from "@mf-rag/db";
import type { CandidateChunkMetadata, ContentCategory } from "@mf-rag/types";

import { buildContextualEmbeddingText } from "../embedding/contextual-input.ts";
import {
  createEmbedder,
  type Embedder,
  type EmbeddingInput,
} from "../embedding/embedder.ts";
import { assertMetadataReviewSnapshot } from "./metadata-publication.ts";

export interface ReviewPublicationProgress {
  stage: "embedding" | "staging" | "publishing";
  completed: number;
  total: number;
}

export interface PublishApprovedReviewOptions {
  actor: string;
  database?: Database;
  embedder?: Embedder;
  ollamaUrl?: string;
  embeddingBatchSize?: number;
  onProgress?: (progress: ReviewPublicationProgress) => void;
}

function stableUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function metadataString(
  metadata: CandidateChunkMetadata,
  key: string,
  fallback = "",
): string {
  const value = metadata[key];
  return typeof value === "string" ? value : fallback;
}

function requiredMetadataString(metadata: CandidateChunkMetadata, key: string): string {
  const value = metadataString(metadata, key);
  if (!value) throw new Error(`Approved chunk metadata is missing ${key}.`);
  return value;
}

async function publishApprovedMetadataReview(
  database: Database,
  detail: NonNullable<Awaited<ReturnType<typeof getReviewRunDetail>>>,
  actor: string,
  onProgress?: (progress: ReviewPublicationProgress) => void,
): Promise<IngestionRun> {
  if (detail.run.status !== "approved") {
    throw new Error("Metadata review run must be approved before publication.");
  }
  const total = detail.candidates.length;
  onProgress?.({ stage: "publishing", completed: 0, total });
  return database.transaction(async (tx) => {
    const sourceRows = detail.run.sourceType === "pdf"
      ? await tx.select({ id: chunks.id, text: chunks.text }).from(chunks).where(and(
          eq(chunks.documentId, detail.run.sourceDocumentId),
          eq(chunks.publicationStatus, "published"),
        ))
      : await tx.select({ id: htmlChunks.id, text: htmlChunks.text }).from(htmlChunks).where(and(
          eq(htmlChunks.documentId, detail.run.sourceDocumentId),
          eq(htmlChunks.publicationStatus, "published"),
        ));
    assertMetadataReviewSnapshot(detail.candidates, sourceRows);
    let completed = 0;
    for (const candidate of detail.candidates) {
      const sourceChunkId = requiredMetadataString(candidate.metadata, "sourceChunkId");
      const updated = detail.run.sourceType === "pdf"
        ? await tx.update(chunks).set({ retrievalMetadata: candidate.metadata }).where(and(
            eq(chunks.id, sourceChunkId),
            eq(chunks.documentId, detail.run.sourceDocumentId),
            eq(chunks.publicationStatus, "published"),
          )).returning({ id: chunks.id })
        : await tx.update(htmlChunks).set({ retrievalMetadata: candidate.metadata }).where(and(
            eq(htmlChunks.id, sourceChunkId),
            eq(htmlChunks.documentId, detail.run.sourceDocumentId),
            eq(htmlChunks.publicationStatus, "published"),
          )).returning({ id: htmlChunks.id });
      if (updated.length !== 1) throw new Error(`Failed to update metadata for source chunk ${sourceChunkId}.`);
      completed += 1;
      onProgress?.({ stage: "publishing", completed, total });
    }
    if (detail.run.sourceType === "pdf") {
      await tx.execute(sql`
        UPDATE ${chunks}
        SET retrieval_metadata = (${chunks.retrievalMetadata} #>> '{}')::jsonb
        WHERE ${chunks.documentId} = ${detail.run.sourceDocumentId}
          AND ${chunks.publicationStatus} = 'published'
          AND jsonb_typeof(${chunks.retrievalMetadata}) = 'string'
      `);
    } else {
      await tx.execute(sql`
        UPDATE ${htmlChunks}
        SET retrieval_metadata = (${htmlChunks.retrievalMetadata} #>> '{}')::jsonb
        WHERE ${htmlChunks.documentId} = ${detail.run.sourceDocumentId}
          AND ${htmlChunks.publicationStatus} = 'published'
          AND jsonb_typeof(${htmlChunks.retrievalMetadata}) = 'string'
      `);
    }
    const [published] = await tx.update(ingestionRuns).set({
      status: "published",
      updatedAt: new Date(),
    }).where(eq(ingestionRuns.id, detail.run.id)).returning();
    if (!published) throw new Error("Failed to publish metadata review run.");
    const [event] = await tx.insert(reviewEvents).values({
      ingestionRunId: detail.run.id,
      eventType: "metadata_published",
      actor,
      details: { updatedChunks: total, embeddingsChanged: false },
    }).returning({ id: reviewEvents.id });
    if (event) {
      await tx.execute(sql`
        UPDATE ${reviewEvents}
        SET details = (${reviewEvents.details} #>> '{}')::jsonb
        WHERE ${reviewEvents.id} = ${event.id}
          AND jsonb_typeof(${reviewEvents.details}) = 'string'
      `);
    }
    return published;
  });
}

async function normalizePublishedPageNumbers(
  database: Database,
  runId: string,
): Promise<void> {
  await database.execute(sql`
    UPDATE ${chunks}
    SET page_numbers = (${chunks.pageNumbers} #>> '{}')::jsonb
    WHERE ${chunks.ingestionRunId} = ${runId}
      AND jsonb_typeof(${chunks.pageNumbers}) = 'string'
  `);
}

export async function publishApprovedReviewRun(
  runId: string,
  options: PublishApprovedReviewOptions,
): Promise<IngestionRun> {
  const database = options.database ?? db;
  const detail = await getReviewRunDetail(database, runId);
  if (!detail) throw new Error("Review run not found.");
  if (detail.run.status !== "approved" && detail.run.status !== "failed") {
    throw new Error("Review run must be approved before embedding.");
  }
  if (detail.candidates.length !== detail.run.candidateChunkCount) {
    throw new Error("Approved candidate count changed before embedding.");
  }

  if (detail.run.reviewPurpose === "metadata") {
    return publishApprovedMetadataReview(
      database,
      detail,
      options.actor,
      options.onProgress,
    );
  }

  const embedder = options.embedder ?? createEmbedder({
    baseUrl: options.ollamaUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    batchSize: options.embeddingBatchSize ?? 10,
  });
  const total = detail.candidates.length;
  const startingStatus = detail.run.status;

  await updateReviewRunStatus(database, runId, startingStatus, "embedding", options.actor);

  try {
    // A failed attempt may have left an incomplete staged version. It was never
    // searchable, so it is safe to replace before retrying the same reviewed run.
    if (detail.run.sourceType === "pdf") {
      await database.delete(chunks).where(eq(chunks.ingestionRunId, runId));
    } else {
      await database.delete(htmlChunks).where(eq(htmlChunks.ingestionRunId, runId));
    }

    const embeddingInputs: EmbeddingInput[] = detail.candidates.map((candidate) => ({
      chunkIndex: candidate.chunkIndex,
      text: buildContextualEmbeddingText(candidate.text, {
        fund: metadataString(candidate.metadata, "fundName") || null,
        document: metadataString(candidate.metadata, "documentType", detail.run.sourceName),
        section: candidate.sectionHeader,
        pages: candidate.pageNumbers,
        contentType: candidate.hasTable
          ? "table row"
          : detail.run.sourceType === "html"
            ? "article"
            : "document text",
      }),
    }));
    const embeddings = await embedder.embedBatch(embeddingInputs, (progress) => {
      options.onProgress?.({
        stage: "embedding",
        completed: progress.completed,
        total: progress.total,
      });
    });
    const embeddingByIndex = new Map(
      embeddings.map((embedding) => [embedding.chunkIndex, embedding.embedding]),
    );
    options.onProgress?.({ stage: "staging", completed: 0, total });

    if (detail.run.sourceType === "pdf") {
      await database.insert(chunks).values(detail.candidates.map((candidate) => {
        const vector = embeddingByIndex.get(candidate.chunkIndex);
        if (!vector) throw new Error(`Missing embedding for chunk ${candidate.chunkIndex}.`);
        const metadata = candidate.metadata;
        return {
          id: stableUuid(`${runId}:pdf:${candidate.chunkIndex}`),
          embedding: vector,
          text: candidate.text,
          chunkIndex: candidate.chunkIndex,
          totalChunks: total,
          documentId: detail.run.sourceDocumentId,
          documentFilename: detail.run.sourceName,
          pageNumbers: candidate.pageNumbers,
          fundName: metadataString(metadata, "fundName"),
          amcName: metadataString(metadata, "amcName"),
          schemeType: metadataString(metadata, "schemeType"),
          schemeCategory: metadataString(metadata, "schemeCategory"),
          docType: requiredMetadataString(metadata, "documentType"),
          documentDate: metadataString(metadata, "documentDate"),
          hasTable: candidate.hasTable,
          sectionHeader: candidate.sectionHeader,
          sebiSchemeId: metadataString(metadata, "sebiSchemeId"),
          sebiUrl: metadataString(metadata, "sebiUrl"),
          knowledgeDomain: requiredMetadataString(metadata, "knowledgeDomain"),
          sourceCollection: requiredMetadataString(metadata, "sourceCollection"),
          amcSlug: metadataString(metadata, "amcSlug") || null,
          ingestionRunId: runId,
          publicationStatus: "staged",
        };
      }));
      await normalizePublishedPageNumbers(database, runId);
    } else {
      await database.insert(htmlChunks).values(detail.candidates.map((candidate) => {
        const vector = embeddingByIndex.get(candidate.chunkIndex);
        if (!vector) throw new Error(`Missing embedding for chunk ${candidate.chunkIndex}.`);
        const metadata = candidate.metadata;
        return {
          id: stableUuid(`${runId}:html:${candidate.chunkIndex}`),
          embedding: vector,
          text: candidate.text,
          chunkIndex: candidate.chunkIndex,
          totalChunks: total,
          documentId: detail.run.sourceDocumentId,
          documentTitle: detail.run.sourceName,
          sourceUrl: requiredMetadataString(metadata, "sourceUrl"),
          contentCategory: requiredMetadataString(metadata, "documentType") as ContentCategory,
          sectionHeading: candidate.sectionHeader,
          hasTable: candidate.hasTable,
          knowledgeDomain: requiredMetadataString(metadata, "knowledgeDomain"),
          sourceCollection: requiredMetadataString(metadata, "sourceCollection"),
          amcSlug: metadataString(metadata, "amcSlug") || null,
          ingestionRunId: runId,
          publicationStatus: "staged",
        };
      }));
    }

    options.onProgress?.({ stage: "staging", completed: total, total });
    await updateReviewRunStatus(database, runId, "embedding", "staged", options.actor);
    options.onProgress?.({ stage: "publishing", completed: 0, total });
    const published = await publishReviewRun(database, runId, options.actor);
    options.onProgress?.({ stage: "publishing", completed: total, total });
    return published;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await markReviewRunFailed(database, runId, options.actor, message);
    } catch {
      // Preserve the embedding/publication error if failure-state recording fails.
    }
    throw error;
  }
}
