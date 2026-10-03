/**
 * Maps the Docling parse artifact's chunks into the semantic-chunker
 * `ChunkResult` consumed by review preparation.
 *
 * A chunk's scheme (`fundName`) comes from headings, never from body text:
 * 1. its own headings: the nearest (last) heading naming a scheme wins
 *    (`extractSchemeTitleLine` after dropping `(NSE Symbol: ...)`,
 *    `(Erstwhile/Formerly known as ...)`, ` - Fund Managers - ...` and footnote
 *    markers; a heading holding only a former name names no scheme);
 * 2. else its page's scheme, but only when the headings of all chunks on that
 *    page name exactly one distinct scheme (compared ignoring case, spacing and
 *    a trailing "Fund"). Pages naming several schemes (SIP/performance tables,
 *    fund facts, offering lists) or none leave the chunk unstamped. A chunk on
 *    several pages needs every page to agree; a scheme is never carried to
 *    another page.
 * A determined scheme is prepended to the chunk text when missing so
 * retrieval's factsheet check (scheme name in candidate text) holds; an
 * unstamped chunk gets no prefix.
 */

import type { DoclingWireChunk } from "../parsers/docling-contract.ts";
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
  const pageSchemes = pageSchemeNames(artifact.chunks);
  const chunks = artifact.chunks.map((wire): Chunk => {
    const scheme = ownScheme(wire.headings) ?? pageScheme(wire.pages.map((pageNumber) => pageSchemes.get(pageNumber) ?? []));
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

/** Parentheticals and trailing clauses that follow a scheme name inside a heading. */
const HEADING_SCHEME_NOISE: readonly RegExp[] = [
  /\s*\((?:NSE|BSE)\b[^)]*\)/gi,
  /\s*\(?\s*\b(?:Erstwhile|Formerly)\s+known\b[^)]*\)?/gi,
  /\s+-\s+Fund\s+Managers?\b.*$/i,
  /\s*[*^#@$†ε]+(?=\s|$)/g,
];

/** Category overview pages (`Mirae Asset Active FOF Snapshot`) carry a scheme term but name no scheme. */
const NON_SCHEME_HEADING = /\bSnapshot\b/i;

/** The scheme a single heading names, if any. */
function headingScheme(heading: string): string | null {
  if (NON_SCHEME_HEADING.test(heading)) return null;
  return extractSchemeTitleLine(HEADING_SCHEME_NOISE.reduce((text, noise) => text.replace(noise, ""), heading));
}

function ownScheme(headings: readonly string[]): string | null {
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const scheme = headingScheme(headings[index]!);
    if (scheme) return scheme;
  }
  return null;
}

function schemeKey(scheme: string): string {
  return normalizedForMatch(scheme).replace(/ fund$/, "");
}

/** Distinct schemes named by the headings of each page's chunks, in first-seen order. */
export function pageSchemeNames(chunks: readonly Pick<DoclingWireChunk, "pages" | "headings">[]): Map<number, string[]> {
  const pages = new Map<number, Map<string, string>>();
  for (const wire of chunks) {
    const schemes = wire.headings.map(headingScheme).filter((scheme): scheme is string => scheme !== null);
    for (const pageNumber of wire.pages) {
      const named = pages.get(pageNumber) ?? new Map<string, string>();
      for (const scheme of schemes) {
        if (!named.has(schemeKey(scheme))) named.set(schemeKey(scheme), scheme);
      }
      pages.set(pageNumber, named);
    }
  }
  return new Map([...pages].map(([pageNumber, named]) => [pageNumber, [...named.values()]]));
}

/** The pages' single shared scheme, or null when any page names none or several, or they disagree. */
function pageScheme(pageSchemes: readonly (readonly string[])[]): string | null {
  const [first] = pageSchemes;
  if (!first || first.length !== 1) return null;
  const key = schemeKey(first[0]!);
  return pageSchemes.every((schemes) => schemes.length === 1 && schemeKey(schemes[0]!) === key) ? first[0]! : null;
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
