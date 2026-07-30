import { createHash } from "node:crypto";

export interface PublishedSourceChunk {
  sourceType: "pdf" | "html";
  sourceDocumentId: string;
  sourceName: string;
  sourceLocation: string | null;
  sourceChunkId: string;
  chunkIndex: number;
  text: string;
  pageNumbers: number[];
  hasTable: boolean;
  sectionHeader: string | null;
  visibilityScope: "GLOBAL" | "TENANT" | "UNCLASSIFIED";
  tenantId: string | null;
  ownershipManifestId: string | null;
  ownershipManifestVersion: number | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function publishedSourceSnapshotHash(rows: PublishedSourceChunk[]): string {
  return sha256(rows.map((row) => [
    row.sourceChunkId,
    sha256(row.text),
    row.visibilityScope,
    row.tenantId ?? "",
    row.ownershipManifestId,
    row.ownershipManifestVersion,
  ].join(":")).join("\n"));
}

export function groupPublishedSourceChunks(
  rows: PublishedSourceChunk[],
): PublishedSourceChunk[][] {
  const byDocument = new Map<string, PublishedSourceChunk[]>();
  for (const row of rows) {
    const key = `${row.sourceType}:${row.sourceDocumentId}`;
    byDocument.set(key, [...(byDocument.get(key) ?? []), row]);
  }
  return [...byDocument.values()].map((documentRows) =>
    [...documentRows].sort((a, b) => a.chunkIndex - b.chunkIndex));
}
