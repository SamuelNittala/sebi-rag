import { prepareManualChunkEdit } from "@mf-rag/core/chunk-inspection";
import {
  applyCandidateEditInspection,
  getDocumentById,
  getReviewRunDetailByCandidateId,
  type Database,
} from "@mf-rag/db";

export interface EditReviewCandidateInput {
  candidateId: string;
  expectedContentHash: string;
  text: string;
  editor: string;
  note: string;
}

function htmlPageCount(pageNumbers: number[][]): number | null {
  const pages = pageNumbers.flat();
  return pages.length > 0 ? Math.max(...pages) + 1 : null;
}

export async function editReviewCandidate(
  db: Database,
  input: EditReviewCandidateInput,
): Promise<{ ingestionRunId: string }> {
  const detail = await getReviewRunDetailByCandidateId(db, input.candidateId);
  if (!detail) throw new Error("Chunk candidate not found.");
  const pageCount = detail.run.sourceType === "pdf"
    ? (await getDocumentById(db, detail.run.sourceDocumentId))?.pageCount ?? null
    : htmlPageCount(detail.candidates.map((candidate) => candidate.pageNumbers));
  const prepared = prepareManualChunkEdit({
    document: {
      id: detail.run.sourceDocumentId,
      filename: detail.run.sourceName,
      pageCount,
      pageNumberBase: detail.run.sourceType === "html" ? 0 : 1,
    },
    candidates: detail.candidates,
    candidateId: input.candidateId,
    expectedContentHash: input.expectedContentHash,
    text: input.text,
  });
  await applyCandidateEditInspection(db, {
    ...prepared,
    ingestionRunId: detail.run.id,
    editor: input.editor,
    note: input.note,
  });
  return { ingestionRunId: detail.run.id };
}
