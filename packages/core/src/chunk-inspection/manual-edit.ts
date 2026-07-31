import { createHash } from "node:crypto";

import { isCuratedFaqMetadata } from "@mf-rag/types";

import { extractFaqAnswer } from "./faq.ts";
import { ChunkInspector } from "./index.ts";
import type {
  EditableInspectionCandidate,
  PreparedManualChunkEdit,
  PrepareManualChunkEditInput,
} from "./types.ts";

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokenCount(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.3);
}

function editedCandidates(
  candidates: EditableInspectionCandidate[],
  candidateId: string,
  text: string,
  tokenCount: number,
  hash: string,
): EditableInspectionCandidate[] {
  return candidates.map((candidate) => {
    if (candidate.id !== candidateId) return candidate;
    const faq = isCuratedFaqMetadata(candidate.metadata);
    if (!faq) return { ...candidate, text, tokenCount, contentHash: hash };
    const question = text.match(/(?:^|\n)Question:\s*(.+?)(?=\n|$)/i)?.[1]?.trim();
    const answer = extractFaqAnswer(text);
    return {
      ...candidate,
      text,
      tokenCount,
      contentHash: hash,
      metadata: {
        ...candidate.metadata,
        originalQuestion: question ?? "",
        answer,
      },
    };
  });
}

export function prepareManualChunkEdit(
  input: PrepareManualChunkEditInput,
): PreparedManualChunkEdit {
  const text = input.text.trim();
  if (!text) throw new Error("Edited chunk text is required.");
  const candidate = input.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) throw new Error("Chunk candidate not found.");
  if (candidate.contentHash !== input.expectedContentHash) {
    throw new Error("Chunk changed after this page was loaded.");
  }
  if (candidate.text.trim() === text) throw new Error("Edited chunk text is unchanged.");

  const afterContentHash = contentHash(text);
  const tokenCount = estimateTokenCount(text);
  const candidates = editedCandidates(
    input.candidates,
    candidate.id,
    text,
    tokenCount,
    afterContentHash,
  );
  const report = new ChunkInspector().inspect({
    document: input.document,
    candidates,
    ownership: input.ownership,
  });
  return {
    candidateId: candidate.id,
    text,
    tokenCount,
    beforeContentHash: candidate.contentHash,
    afterContentHash,
    report,
  };
}
