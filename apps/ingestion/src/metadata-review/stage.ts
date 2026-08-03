import { prepareMiraeSifMetadataReview } from "@mf-rag/core/metadata-review";
import {
  assertClassifiedKnowledgeOwnership,
  type ClassifiedKnowledgeOwnership,
} from "@mf-rag/types";
import {
  and,
  chunks,
  db,
  documents,
  eq,
  htmlChunks,
  htmlDocuments,
  ingestionRuns,
  or,
  sql,
  stageInspectionReview,
  type Database,
} from "@mf-rag/db";
import {
  groupPublishedSourceChunks,
  publishedSourceSnapshotHash,
  type PublishedSourceChunk,
} from "./stage-preparation.ts";

async function loadPublishedMiraeSifChunks(database: Database): Promise<PublishedSourceChunk[]> {
  const [pdf, html] = await Promise.all([
    database.select({
      sourceDocumentId: chunks.documentId,
      sourceName: chunks.documentFilename,
      sourceLocation: documents.filepath,
      sourceChunkId: chunks.id,
      chunkIndex: chunks.chunkIndex,
      text: chunks.text,
      pageNumbers: chunks.pageNumbers,
      hasTable: chunks.hasTable,
      sectionHeader: chunks.sectionHeader,
      visibilityScope: chunks.visibilityScope,
      tenantId: chunks.tenantId,
      ownershipManifestId: chunks.ownershipManifestId,
      ownershipManifestVersion: chunks.ownershipManifestVersion,
    }).from(chunks).innerJoin(documents, eq(chunks.documentId, documents.id)).where(and(
      eq(chunks.publicationStatus, "published"),
      eq(chunks.sourceCollection, "mirae_sif"),
    )),
    database.select({
      sourceDocumentId: htmlChunks.documentId,
      sourceName: htmlChunks.documentTitle,
      sourceLocation: htmlChunks.sourceUrl,
      sourceChunkId: htmlChunks.id,
      chunkIndex: htmlChunks.chunkIndex,
      text: htmlChunks.text,
      hasTable: htmlChunks.hasTable,
      sectionHeader: htmlChunks.sectionHeading,
      visibilityScope: htmlChunks.visibilityScope,
      tenantId: htmlChunks.tenantId,
      ownershipManifestId: htmlChunks.ownershipManifestId,
      ownershipManifestVersion: htmlChunks.ownershipManifestVersion,
    }).from(htmlChunks).innerJoin(htmlDocuments, eq(htmlChunks.documentId, htmlDocuments.id)).where(and(
      eq(htmlChunks.publicationStatus, "published"),
      or(
        eq(htmlChunks.sourceCollection, "mirae_sif"),
        eq(htmlChunks.sourceCollection, "sebi_regulatory"),
      ),
    )),
  ]);
  return [
    ...pdf.map((row) => ({ ...row, sourceType: "pdf" as const })),
    ...html.map((row) => ({ ...row, sourceType: "html" as const, pageNumbers: [] })),
  ];
}

export async function stageMiraeSifMetadataReviews(
  database: Database = db,
): Promise<Array<{ sourceName: string; runId: string; candidateCount: number; findingCount: number }>> {
  const rows = await loadPublishedMiraeSifChunks(database);
  const staged: Array<{ sourceName: string; runId: string; candidateCount: number; findingCount: number }> = [];
  for (const documentRows of groupPublishedSourceChunks(rows)) {
    const first = documentRows[0];
    if (!first) continue;
    const snapshotHash = publishedSourceSnapshotHash(documentRows);
    const ownership = {
      visibilityScope: first.visibilityScope,
      tenantId: first.tenantId,
      ownershipManifestId: first.ownershipManifestId,
      ownershipManifestVersion: first.ownershipManifestVersion,
    } as ClassifiedKnowledgeOwnership;
    assertClassifiedKnowledgeOwnership(ownership);
    if (documentRows.some((row) =>
      row.visibilityScope !== ownership.visibilityScope
      || row.tenantId !== ownership.tenantId
      || row.ownershipManifestId !== ownership.ownershipManifestId
      || row.ownershipManifestVersion !== ownership.ownershipManifestVersion)) {
      throw new Error("Published source chunk ownership is inconsistent.");
    }
    // Rejected/failed runs must not block a restage — a rejection is often
    // followed by a classifier fix and a fresh pass over the same snapshot.
    const [existing] = await database.select({ id: ingestionRuns.id }).from(ingestionRuns).where(and(
      eq(ingestionRuns.sourceType, first.sourceType),
      eq(ingestionRuns.sourceDocumentId, first.sourceDocumentId),
      eq(ingestionRuns.reviewPurpose, "metadata"),
      eq(ingestionRuns.fileHash, snapshotHash),
      sql`${ingestionRuns.status} NOT IN ('rejected', 'failed')`,
    ));
    if (existing) continue;
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: first.sourceType,
        sourceDocumentId: first.sourceDocumentId,
        sourceName: first.sourceName,
        sourceLocation: first.sourceLocation,
      },
      chunks: documentRows.map((row) => ({
        id: row.sourceChunkId,
        chunkIndex: row.chunkIndex,
        text: row.text,
        pageNumbers: row.pageNumbers,
        hasTable: row.hasTable,
        sectionHeader: row.sectionHeader,
      })),
    });
    const run = await stageInspectionReview(database, {
      sourceType: first.sourceType,
      reviewPurpose: "metadata",
      sourceDocumentId: first.sourceDocumentId,
      sourceName: first.sourceName,
      sourceLocation: first.sourceLocation,
      fileHash: snapshotHash,
      parserVersion: "metadata-source-v1",
      chunkerVersion: "metadata-preserve-v1",
      ownership,
      report: {
        inspectorVersion: "mirae-sif-metadata-v1",
        candidateChunkCount: prepared.candidates.length,
        inspectedChunkCount: prepared.candidates.length,
        findings: prepared.findings,
        criticalCount: prepared.findings.filter((finding) => finding.severity === "critical").length,
        warningCount: prepared.findings.filter((finding) => finding.severity === "warning").length,
        blockingCount: prepared.findings.filter((finding) => finding.blocksApproval).length,
      },
      candidates: prepared.candidates,
    });
    staged.push({
      sourceName: first.sourceName,
      runId: run.id,
      candidateCount: prepared.candidates.length,
      findingCount: prepared.findings.length,
    });
  }
  return staged;
}
