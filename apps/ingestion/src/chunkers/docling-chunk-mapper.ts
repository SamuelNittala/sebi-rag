/**
 * Maps the Docling parse artifact's chunks into the semantic-chunker
 * `ChunkResult` consumed by review preparation.
 *
 * Each page is stamped with the scheme named by its own title line
 * (`extractSchemeTitleLine`); a scheme is never carried forward to a page
 * without one. A chunk takes its pages' scheme only when every page agrees, and
 * that scheme is prepended to the chunk text when missing so retrieval's
 * factsheet check (scheme name in candidate text) holds for every chunk.
 */

import type { DoclingPdfParseArtifact } from "../stages/docling-parse-stage.ts";
import { extractSchemeTitleLine } from "../metadata/extractor.ts";
import { estimateTokenCount, type Chunk, type ChunkResult } from "./semantic-chunker.ts";

/** Pages below this many body characters count as low structure when they hold pictures or nothing. */
const LOW_STRUCTURE_BODY_CHARS = 80;

export interface DoclingParserDiagnostics {
  /** `bodyTextChars < 80` with at least one picture, or no items at all. */
  readonly lowStructurePages: number[];
  /** `bodyTextChars >= 80` but referenced by no chunk. */
  readonly uncoveredPages: number[];
}

export interface DoclingChunkMapping {
  readonly chunkResult: ChunkResult;
  readonly parserDiagnostics: DoclingParserDiagnostics;
}

export function mapDoclingChunks(
  artifact: Pick<DoclingPdfParseArtifact, "pages" | "chunks">,
): DoclingChunkMapping {
  const pageSchemes = new Map(artifact.pages.map((page) => [page.pageNumber, extractSchemeTitleLine(page.text)]));
  const chunks = artifact.chunks.map((wire): Chunk => {
    const scheme = chunkScheme(wire.pages.map((pageNumber) => pageSchemes.get(pageNumber) ?? null));
    const body = [...wire.headings, wire.text].join("\n");
    const text = scheme && !normalizedForMatch(body).includes(normalizedForMatch(scheme))
      ? `${scheme}\n${body}`
      : body;
    return {
      text,
      chunkIndex: wire.chunkIndex,
      pageNumbers: [...wire.pages],
      hasTable: wire.type === "table",
      sectionHeader: wire.headings.at(-1) ?? null,
      tokenCount: estimateTokenCount(text),
      metadata: {
        parser: "docling",
        chunkType: wire.type,
        normalizationFlags: [...wire.flags],
        sourceItemRefs: [...wire.itemRefs],
        ...(wire.picture ? { pictureClassification: wire.picture.classification } : {}),
        ...(scheme ? { fundName: scheme } : {}),
      },
    };
  });
  return {
    chunkResult: {
      chunks,
      totalChunks: chunks.length,
      totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
    },
    parserDiagnostics: parserDiagnostics(artifact),
  };
}

function chunkScheme(schemes: readonly (string | null)[]): string | null {
  const [first] = schemes;
  return first && schemes.every((scheme) => scheme === first) ? first : null;
}

/** Same normalization retrieval applies before its scheme-name containment check. */
function normalizedForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parserDiagnostics(artifact: Pick<DoclingPdfParseArtifact, "pages" | "chunks">): DoclingParserDiagnostics {
  const referenced = new Set(artifact.chunks.flatMap((chunk) => chunk.pages));
  const lowStructurePages = artifact.pages
    .filter(({ stats }) => stats.bodyTextChars < LOW_STRUCTURE_BODY_CHARS
      && (stats.pictures > 0 || stats.textItems + stats.tables + stats.pictures === 0))
    .map((page) => page.pageNumber);
  const uncoveredPages = artifact.pages
    .filter((page) => page.stats.bodyTextChars >= LOW_STRUCTURE_BODY_CHARS && !referenced.has(page.pageNumber))
    .map((page) => page.pageNumber);
  return { lowStructurePages, uncoveredPages };
}
