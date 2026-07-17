import {
  miraeSifStrategies,
  miraeSifSectionTypes,
  type MiraeSifMetadataProposal,
} from "@mf-rag/core/metadata-review";
import type { CandidateChunkMetadata, DocumentScope } from "@mf-rag/types";
import type { Database } from "@mf-rag/db/client";

const documentScopes: readonly DocumentScope[] = [
  "strategy", "sif_umbrella", "amc", "regulatory", "unknown",
];
const factTypes = new Set<string>([
  "", "fund_manager",
  ...miraeSifSectionTypes.filter((value) =>
    !["strategy_management", "staff_directory", "fund_facts", "overview", "unknown"].includes(value)),
]);

export interface MetadataEditValues {
  documentScope: string;
  strategyId: string;
  sectionType: string;
  factType: string;
  note: string;
}

export function prepareMetadataEdit(
  current: CandidateChunkMetadata,
  values: MetadataEditValues,
): CandidateChunkMetadata {
  if (!documentScopes.includes(values.documentScope as DocumentScope)) {
    throw new Error("Invalid document scope.");
  }
  if (!miraeSifSectionTypes.includes(values.sectionType as never)) {
    throw new Error("Invalid section type.");
  }
  if (!factTypes.has(values.factType)) throw new Error("Invalid fact type.");
  if (!values.note.trim()) throw new Error("A metadata review note is required.");
  const strategy = miraeSifStrategies.find((item) => item.id === values.strategyId.trim());
  if (values.documentScope === "strategy" && !strategy) {
    throw new Error("Strategy-scoped metadata requires a known strategy ID.");
  }
  if (values.documentScope !== "strategy" && values.strategyId.trim()) {
    throw new Error("Only strategy-scoped metadata can have a strategy ID.");
  }
  return {
    ...current,
    documentScope: values.documentScope as DocumentScope,
    strategyId: strategy?.id ?? null,
    canonicalStrategyName: strategy?.name ?? null,
    sectionType: values.sectionType,
    factType: values.factType || null,
    confidence: 1,
    classificationSource: "human",
    evidence: [values.note.trim()],
  } satisfies CandidateChunkMetadata;
}

export async function editReviewCandidateMetadata(
  db: Database,
  input: MetadataEditValues & {
    candidateId: string;
    expectedContentHash: string;
    editor: string;
  },
): Promise<{ ingestionRunId: string }> {
  const { getReviewRunDetailByCandidateId, updateReviewCandidateMetadata } = await import("@mf-rag/db");
  const detail = await getReviewRunDetailByCandidateId(db, input.candidateId);
  if (!detail) throw new Error("Chunk candidate not found.");
  const candidate = detail.candidates.find((item) => item.id === input.candidateId);
  if (!candidate) throw new Error("Chunk candidate not found.");
  const metadata = prepareMetadataEdit(candidate.metadata, input) as MiraeSifMetadataProposal;
  await updateReviewCandidateMetadata(db, {
    ingestionRunId: detail.run.id,
    candidateId: input.candidateId,
    expectedContentHash: input.expectedContentHash,
    metadata,
    editor: input.editor,
    note: input.note,
  });
  return { ingestionRunId: detail.run.id };
}
