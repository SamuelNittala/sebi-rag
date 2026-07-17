import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { assertMetadataReviewSnapshot } from "./metadata-publication.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("metadata review publication snapshot", () => {
  test("accepts unchanged published source chunks", () => {
    expect(() => assertMetadataReviewSnapshot([{
      chunkIndex: 3,
      contentHash: sha256("investment objective"),
      metadata: { sourceChunkId: "source-3" },
    }], [{ id: "source-3", text: "investment objective" }])).not.toThrow();
  });

  test("rejects changed text before writing approved metadata", () => {
    expect(() => assertMetadataReviewSnapshot([{
      chunkIndex: 3,
      contentHash: sha256("investment objective"),
      metadata: { sourceChunkId: "source-3" },
    }], [{ id: "source-3", text: "changed objective" }])).toThrow(
      "Published source chunk source-3 changed after metadata staging.",
    );
  });

  test("rejects a changed source chunk set", () => {
    expect(() => assertMetadataReviewSnapshot([], [{ id: "source-3", text: "extra" }])).toThrow(
      "Published source chunk count changed after metadata staging.",
    );
  });
});
