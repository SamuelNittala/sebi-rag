import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import { DEFAULT_CHUNK_CONFIG } from "@mf-rag/types";

import type { DoclingPdfParseArtifact } from "../stages/docling-parse-stage.ts";
import { prepareChunkReview } from "../review/review-preparation.ts";
import { mapDoclingChunks } from "./docling-chunk-mapper.ts";

/**
 * Guard for the Docling normalizer's chunk budget (python/docling_service/normalize/budget.py):
 * every committed golden wire, mapped exactly as ingestion maps it (scheme prefix + headings + body),
 * must pass the chunk inspector without TOKEN_LIMIT_EXCEEDED.
 */
const FIXTURE_DIR = new URL("../../../../tests/fixtures/docling/", import.meta.url);
const WIRES = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".wire.json")).sort();

describe("Docling golden wires stay within the inspector's token limits", () => {
  test("the normalizer budget's limits match DEFAULT_CHUNK_CONFIG", () => {
    // Pinned in budget.py (TEXT_MAX_TOKENS, TABLE_MAX_TOKENS) and its test.
    expect(DEFAULT_CHUNK_CONFIG.maxTokens).toBe(512);
    expect(DEFAULT_CHUNK_CONFIG.tableMaxTokens).toBe(1536);
  });

  test("golden wires exist", () => {
    expect(WIRES.length).toBeGreaterThan(0);
  });

  test.each(WIRES)("%s has no TOKEN_LIMIT_EXCEEDED", async (name) => {
    const wire = await Bun.file(new URL(name, FIXTURE_DIR)).json() as Pick<DoclingPdfParseArtifact, "pages" | "chunks">;
    const { chunkResult } = mapDoclingChunks(wire);
    const { report } = prepareChunkReview({
      document: { id: name, filename: name.replace(".wire.json", ".pdf"), pageCount: wire.pages.length },
      chunks: chunkResult.chunks,
      metadata: { documentScope: "strategy" },
    });
    const overLimit = report.findings
      .filter((finding) => finding.ruleCode === "TOKEN_LIMIT_EXCEEDED")
      .map((finding) => ({ chunkIndex: finding.chunkIndex, ...finding.evidence }));
    expect(overLimit).toEqual([]);
  });
});
