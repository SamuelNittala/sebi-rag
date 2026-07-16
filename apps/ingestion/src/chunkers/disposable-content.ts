import { estimateTokenCount, type Chunk, type ChunkResult } from "./semantic-chunker.ts";

export interface DisposableSifChunkCandidate {
  documentFilename: string;
  pageNumbers: number[];
  text: string;
}

type CuratableChunk = Pick<DisposableSifChunkCandidate, "pageNumbers" | "text">;

const PLATINUM_HYBRID_KIM = /^KIM-Platinum-Hybrid-Long-Short-Fund\.pdf$/i;
const PLATINUM_HYBRID_KIM_APPENDIX_START = 22;
const PLATINUM_SIF_SAI = /^SAI-SIF_March-2026\.pdf$/i;
const SAI_EXCLUDED_PAGES = new Set([
  1, 2, 4, 5, 11, 12, 13,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  116, 122, 127, 133, 134,
]);
const FORM_MARKERS = /DISTRIBUTOR INFORMATION FOR OFFICE USE ONLY|APPLICANT INFORMATION TO BE FILLED IN BLOCK LETTERS|ASBA ACKNOWLEDGEMENT SLIP|DECLARATION AND SIGNATURES|SIP ENROLMENT DETAILS|ONE TIME MANDATE/i;

function includesPage(chunk: CuratableChunk, page: number): boolean {
  return chunk.pageNumbers.includes(page);
}

function fullyExcludedSaiPages(pageNumbers: number[]): boolean {
  return pageNumbers.length > 0 && pageNumbers.every((page) => SAI_EXCLUDED_PAGES.has(page));
}

function keepFrom(text: string, marker: RegExp): string {
  const match = marker.exec(text);
  marker.lastIndex = 0;
  return match?.index === undefined ? text : text.slice(match.index);
}

function keepBefore(text: string, marker: RegExp): string {
  const match = marker.exec(text);
  marker.lastIndex = 0;
  return match?.index === undefined ? text : text.slice(0, match.index);
}

function removeBetween(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text);
  start.lastIndex = 0;
  if (startMatch?.index === undefined) return text;

  const suffix = text.slice(startMatch.index);
  const endMatch = end.exec(suffix);
  end.lastIndex = 0;
  if (endMatch?.index === undefined) return text.slice(0, startMatch.index);

  return `${text.slice(0, startMatch.index)}\n${suffix.slice(endMatch.index)}`;
}

function normalizedText(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

function curateSaiText(chunk: CuratableChunk): string {
  let text = chunk.text;

  if (includesPage(chunk, 6)) {
    text = keepFrom(text, /\(1\) Appointment and termination of asset management company/i);
  }
  if (includesPage(chunk, 14)) {
    text = keepFrom(text, /1\. Investment and operational due diligence/i);
  }
  if (includesPage(chunk, 33)) {
    text = keepFrom(text, /III\. Service providers/i);
  }
  if (includesPage(chunk, 35)) {
    text = keepFrom(text, /V\.\s*RISK FACTORS/i);
  }
  if (includesPage(chunk, 68)) {
    text = keepFrom(text, /VII\. RIGHTS OF UNITHOLDERS OF THE INVESTMENT STRATEGY/i);
  }

  if (chunk.pageNumbers.some((page) => page >= 115 && page <= 117)) {
    text = removeBetween(
      text,
      /(?:Details of transactions with Associates:|The Brokerage\/ Commission \/ charges paid)/i,
      /Mode of Holding/i,
    );
    if (includesPage(chunk, 117) && /Trusteeship Fees paid|Investment Management Fees paid/i.test(text)) {
      text = /Mode of Holding/i.test(text) ? keepFrom(text, /Mode of Holding/i) : "";
    }
  }

  if (includesPage(chunk, 123)) {
    text = keepFrom(text, /(?:^|\n)\s*[•●]?\s*Options\s*$/im);
  }
  if (chunk.pageNumbers.some((page) => page === 130 || page === 131)) {
    text = removeBetween(
      text,
      /Swing Pricing during normal times/i,
      /3\. Provisions on Creation of Segregated Portfolio\/Side Pocketing/i,
    );
    if (includesPage(chunk, 131) && /Re-opening of Investment Strategy after announcement of Winding Up/i.test(text)) {
      text = keepFrom(text, /3\. Provisions on Creation of Segregated Portfolio\/Side Pocketing/i);
    }
  }
  if (includesPage(chunk, 138)) {
    text = keepBefore(text, /For and on behalf of the Board of Directors/i);
  }

  return normalizedText(text);
}

function curateChunk(chunk: Chunk, documentFilename: string): Chunk | null {
  if (isDisposableSifChunk({
    documentFilename,
    pageNumbers: chunk.pageNumbers,
    text: chunk.text,
  })) return null;
  if (!PLATINUM_SIF_SAI.test(documentFilename)) return chunk;

  const text = curateSaiText(chunk);
  if (!text) return null;
  const textChanged = text !== chunk.text;
  return {
    ...chunk,
    text,
    tokenCount: estimateTokenCount(text),
    sectionHeader: textChanged ? text.split("\n", 1)[0] ?? null : chunk.sectionHeader,
  };
}

export function isDisposableSifChunk(
  candidate: DisposableSifChunkCandidate,
): boolean {
  if (FORM_MARKERS.test(candidate.text)) return true;
  if (PLATINUM_SIF_SAI.test(candidate.documentFilename)) {
    return fullyExcludedSaiPages(candidate.pageNumbers);
  }
  if (!PLATINUM_HYBRID_KIM.test(candidate.documentFilename)) return false;
  return candidate.pageNumbers.some(
    (page) => page >= PLATINUM_HYBRID_KIM_APPENDIX_START,
  );
}

export function removeDisposableSifChunks(
  chunkResult: ChunkResult,
  documentFilename: string,
): ChunkResult {
  const chunks = chunkResult.chunks
    .map((chunk) => curateChunk(chunk, documentFilename))
    .filter((chunk): chunk is Chunk => chunk !== null)
    .map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));

  return {
    chunks,
    totalChunks: chunks.length,
    totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
  };
}
