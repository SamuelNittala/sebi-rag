import { describe, expect, test } from "bun:test";

import { mapDoclingChunks } from "../../../../ingestion/src/chunkers/docling-chunk-mapper.ts";
import type { DoclingWireChunk } from "../../../../ingestion/src/parsers/docling-contract.ts";
import type { DoclingPdfParseArtifact } from "../../../../ingestion/src/stages/docling-parse-stage.ts";
import { alignCandidatesToWire, isCompatible, type AlignableCandidate } from "./chunk-alignment.ts";

const GOLDEN_DIR = new URL("../../../../../tests/fixtures/docling/", import.meta.url);
const GOLDENS = [
  "mirae-flexi-cap-p34-35",
  "mirae-fund-facts-p10",
  "mirae-fund-performance-p88",
  "mirae-fund-performance-p98",
  "mirae-passive-etf-p34",
  "mirae-passive-offerings-p9",
  "mirae-sip-performance-p103",
  "mirae-sip-performance-p104",
] as const;

type Wire = Pick<DoclingPdfParseArtifact, "pages" | "chunks">;

interface TestCandidate extends AlignableCandidate {
  /** Wire chunk the candidate was built from (test bookkeeping only). */
  readonly origin: number;
}

async function golden(stem: string): Promise<Wire> {
  return await Bun.file(new URL(`${stem}.wire.json`, GOLDEN_DIR)).json();
}

/** Candidates exactly as chunk-inspect-stage stages them for a Docling run. */
function candidatesFor(wire: Wire): TestCandidate[] {
  return mapDoclingChunks(wire).chunkResult.chunks.map((chunk) => ({
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    pageNumbers: chunk.pageNumbers,
    metadata: chunk.metadata,
    origin: chunk.chunkIndex,
  }));
}

/** Drops candidates and re-numbers the rest, like `removeDisposableSifChunks`. */
function dropAndRenumber(candidates: readonly TestCandidate[], dropOrigins: readonly number[]): TestCandidate[] {
  return candidates
    .filter((candidate) => !dropOrigins.includes(candidate.origin))
    .map((candidate, chunkIndex) => ({ ...candidate, chunkIndex }));
}

function onPage<T extends { readonly pages: readonly number[] }>(chunks: readonly T[], page: number): T[] {
  return chunks.filter((chunk) => chunk.pages.includes(page));
}

function candidatesOnPage(candidates: readonly TestCandidate[], page: number): TestCandidate[] {
  return candidates.filter((candidate) => candidate.pageNumbers.includes(page));
}

function pairedOrigins(alignment: ReturnType<typeof alignCandidatesToWire<TestCandidate, DoclingWireChunk>>) {
  return alignment.pairs.map(({ candidate, wire }) => [candidate.origin, wire.chunkIndex]);
}

describe("alignCandidatesToWire", () => {
  test("pairs every candidate of every golden with its own wire chunk, page by page", async () => {
    for (const stem of GOLDENS) {
      const wire = await golden(stem);
      const candidates = candidatesFor(wire);
      for (const { pageNumber } of wire.pages) {
        const alignment = alignCandidatesToWire(candidatesOnPage(candidates, pageNumber), onPage(wire.chunks, pageNumber));

        expect(alignment.unmatchedCandidates).toEqual([]);
        expect(alignment.unmatchedWire).toEqual([]);
        for (const { candidate, wire: chunk } of alignment.pairs) {
          expect(candidate.chunkIndex).toBe(chunk.chunkIndex);
        }
      }
    }
  });

  test("re-indexed candidates (mirae_sif disposable chunks removed) still pair with their wire chunks", async () => {
    const wire = await golden("mirae-flexi-cap-p34-35");
    const candidates = dropAndRenumber(candidatesFor(wire), [5, 18]);

    const pageOne = alignCandidatesToWire(candidatesOnPage(candidates, 1), onPage(wire.chunks, 1));
    const pageTwo = alignCandidatesToWire(candidatesOnPage(candidates, 2), onPage(wire.chunks, 2));

    for (const alignment of [pageOne, pageTwo]) {
      for (const [origin, wireIndex] of pairedOrigins(alignment)) expect(origin).toBe(wireIndex!);
      expect(alignment.unmatchedCandidates).toEqual([]);
    }
    expect(pageOne.pairs).toHaveLength(16);
    expect(pageOne.unmatchedWire.map((chunk) => chunk.chunkIndex)).toEqual([5]);
    expect(pageTwo.unmatchedWire.map((chunk) => chunk.chunkIndex)).toEqual([18]);
    // Candidate 17 (wire 19) shows the shift the alignment has to absorb.
    expect(pageTwo.pairs.find(({ wire: chunk }) => chunk.chunkIndex === 19)?.candidate.chunkIndex).toBe(17);
  });

  test("split table parts sharing one item ref and page pair by text when a middle part was dropped", async () => {
    for (const stem of ["mirae-sip-performance-p103", "mirae-sip-performance-p104"]) {
      const wire = await golden(stem);
      expect(new Set(wire.chunks.map((chunk) => chunk.itemRefs.join())).size).toBe(1);
      const candidates = dropAndRenumber(candidatesFor(wire), [2]);

      const alignment = alignCandidatesToWire(candidates, wire.chunks);

      expect(pairedOrigins(alignment)).toEqual([[0, 0], [1, 1], [3, 3], [4, 4], [5, 5]]);
      expect(alignment.unmatchedWire.map((chunk) => chunk.chunkIndex)).toEqual([2]);
    }
  });

  test("split table parts still pair when a neighbour of the dropped part was edited", async () => {
    const wire = await golden("mirae-sip-performance-p103");
    const candidates = dropAndRenumber(candidatesFor(wire), [2])
      .map((candidate) => candidate.origin === 4 ? { ...candidate, text: "Reviewer rewrote this SIP table." } : candidate);

    const alignment = alignCandidatesToWire(candidates, wire.chunks);

    expect(pairedOrigins(alignment)).toEqual([[0, 0], [1, 1], [3, 3], [4, 4], [5, 5]]);
  });

  test("an edited candidate (text replaced, metadata kept) still matches", async () => {
    const wire = await golden("mirae-flexi-cap-p34-35");
    const candidates = candidatesFor(wire)
      .map((candidate) => candidate.origin === 10 ? { ...candidate, text: "Completely rewritten by a reviewer." } : candidate);

    const alignment = alignCandidatesToWire(candidatesOnPage(candidates, 1), onPage(wire.chunks, 1));

    expect(alignment.unmatchedCandidates).toEqual([]);
    expect(alignment.pairs.find(({ candidate }) => candidate.origin === 10)?.wire.chunkIndex).toBe(10);
  });

  test("addendum candidates (no parser metadata) are all unmatched and every wire chunk is listed", async () => {
    const wire = await golden("mirae-flexi-cap-p34-35");
    const addendum: TestCandidate[] = [0, 1, 2].map((chunkIndex) => ({
      chunkIndex,
      text: `Provision ${chunkIndex}`,
      pageNumbers: [1],
      metadata: { documentScope: "strategy", documentType: "Addendum" },
      origin: -1,
    }));

    const alignment = alignCandidatesToWire(addendum, onPage(wire.chunks, 1));

    expect(alignment.pairs).toEqual([]);
    expect(alignment.unmatchedCandidates).toEqual(addendum);
    expect(alignment.unmatchedWire).toHaveLength(17);
  });

  test("a candidate whose item refs no longer match is unmatched; its wire chunk is listed", async () => {
    const wire = await golden("mirae-fund-facts-p10");
    // Chunk 3 is the page notes text chunk (its own item refs; chunks 0-2 are fund columns of one table).
    const candidates = candidatesFor(wire).map((candidate) => candidate.origin === 3
      ? { ...candidate, metadata: { ...(candidate.metadata as object), sourceItemRefs: ["#/texts/999"] } }
      : candidate);

    const alignment = alignCandidatesToWire(candidates, wire.chunks);

    expect(pairedOrigins(alignment)).toEqual([[0, 0], [1, 1], [2, 2], [4, 4]]);
    expect(alignment.unmatchedCandidates.map((candidate) => candidate.origin)).toEqual([3]);
    expect(alignment.unmatchedWire.map((chunk) => chunk.chunkIndex)).toEqual([3]);
  });

  test("sorts both inputs by chunk index without mutating them", async () => {
    const wire = await golden("mirae-fund-facts-p10");
    const candidates = candidatesFor(wire).reverse();
    const wireChunks = [...wire.chunks].reverse();

    const alignment = alignCandidatesToWire(candidates, wireChunks);

    expect(pairedOrigins(alignment)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(candidates.map((candidate) => candidate.origin)).toEqual([4, 3, 2, 1, 0]);
  });
});

describe("isCompatible", () => {
  const wire = { chunkIndex: 0, text: "Body", pages: [3, 4], itemRefs: ["#/tables/1"] };
  const candidate = {
    chunkIndex: 0,
    text: "Body",
    pageNumbers: [3, 4],
    metadata: { parser: "docling", sourceItemRefs: ["#/tables/1"] },
  };

  test("requires the docling parser, equal item refs and equal pages", () => {
    expect(isCompatible(candidate, wire)).toBe(true);
    expect(isCompatible({ ...candidate, metadata: { ...candidate.metadata, parser: "unpdf" } }, wire)).toBe(false);
    expect(isCompatible({ ...candidate, pageNumbers: [3] }, wire)).toBe(false);
    expect(isCompatible({ ...candidate, metadata: { parser: "docling", sourceItemRefs: [] } }, wire)).toBe(false);
    expect(isCompatible({ ...candidate, metadata: { parser: "docling" } }, wire)).toBe(false);
    expect(isCompatible({ ...candidate, metadata: null }, wire)).toBe(false);
  });
});
