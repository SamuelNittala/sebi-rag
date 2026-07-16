import type { ChunkResult } from "./semantic-chunker.ts";

export interface DisposableSifChunkCandidate {
  documentFilename: string;
  pageNumbers: number[];
  text: string;
}

const PLATINUM_HYBRID_KIM = /^KIM-Platinum-Hybrid-Long-Short-Fund\.pdf$/i;
const PLATINUM_HYBRID_KIM_APPENDIX_START = 22;
const FORM_MARKERS = /DISTRIBUTOR INFORMATION FOR OFFICE USE ONLY|APPLICANT INFORMATION TO BE FILLED IN BLOCK LETTERS|ASBA ACKNOWLEDGEMENT SLIP|DECLARATION AND SIGNATURES|SIP ENROLMENT DETAILS|ONE TIME MANDATE/i;

export function isDisposableSifChunk(
  candidate: DisposableSifChunkCandidate,
): boolean {
  if (FORM_MARKERS.test(candidate.text)) return true;
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
    .filter((chunk) => !isDisposableSifChunk({
      documentFilename,
      pageNumbers: chunk.pageNumbers,
      text: chunk.text,
    }))
    .map((chunk, chunkIndex) => ({ ...chunk, chunkIndex }));

  return {
    chunks,
    totalChunks: chunks.length,
    totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
  };
}
