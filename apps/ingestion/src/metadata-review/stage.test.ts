import { describe, expect, test } from "bun:test";

import {
  groupPublishedSourceChunks,
  publishedSourceSnapshotHash,
  type PublishedSourceChunk,
} from "./stage-preparation.ts";

function row(overrides: Partial<PublishedSourceChunk>): PublishedSourceChunk {
  return {
    sourceType: "html",
    sourceDocumentId: "document-a",
    sourceName: "Platinum Hybrid Long-Short Fund",
    sourceLocation: "https://example.com/fund?schemeCode=3166",
    sourceChunkId: "chunk-a",
    chunkIndex: 0,
    text: "Objective",
    pageNumbers: [],
    hasTable: false,
    sectionHeader: "Investment Objective",
    ...overrides,
  };
}

describe("Mirae SIF metadata staging", () => {
  test("keeps same-title HTML sources as separate document reviews and sorts chunks", () => {
    const groups = groupPublishedSourceChunks([
      row({ sourceDocumentId: "document-a", sourceChunkId: "chunk-a-2", chunkIndex: 2 }),
      row({ sourceDocumentId: "document-b", sourceChunkId: "chunk-b-0", chunkIndex: 0 }),
      row({ sourceDocumentId: "document-a", sourceChunkId: "chunk-a-0", chunkIndex: 0 }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.map((chunk) => chunk.sourceChunkId)).toEqual(["chunk-a-0", "chunk-a-2"]);
    expect(groups[1]?.map((chunk) => chunk.sourceChunkId)).toEqual(["chunk-b-0"]);
  });

  test("changes the idempotency snapshot when published text changes", () => {
    const original = [row({})];
    const changed = [row({ text: "Changed objective" })];

    expect(publishedSourceSnapshotHash(original)).not.toBe(publishedSourceSnapshotHash(changed));
  });
});
