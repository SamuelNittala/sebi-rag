import { createHash } from "node:crypto";

import type { CandidateChunkMetadata } from "@mf-rag/types";

export interface MetadataSnapshotCandidate {
  chunkIndex: number;
  contentHash: string;
  metadata: CandidateChunkMetadata;
}

export interface MetadataSnapshotSource {
  id: string;
  text: string;
}

export function assertMetadataReviewSnapshot(
  candidates: MetadataSnapshotCandidate[],
  sourceRows: MetadataSnapshotSource[],
): void {
  if (sourceRows.length !== candidates.length) {
    throw new Error("Published source chunk count changed after metadata staging.");
  }
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const candidate of candidates) {
    const rawSourceChunkId = candidate.metadata.sourceChunkId;
    const sourceChunkId = typeof rawSourceChunkId === "string" ? rawSourceChunkId : "";
    const source = sourceById.get(sourceChunkId);
    const currentHash = source
      ? createHash("sha256").update(source.text).digest("hex")
      : null;
    if (!source || currentHash !== candidate.contentHash) {
      throw new Error(`Published source chunk ${sourceChunkId || candidate.chunkIndex} changed after metadata staging.`);
    }
  }
}
