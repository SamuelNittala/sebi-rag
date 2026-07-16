export type RetrievalRankingProfile = "mirae_sif_overview";

export interface RetrievalRankingCandidate {
  score: number;
  sourceType: "scheme_document" | "knowledge_base";
  text: string;
  sectionHeader?: string | null;
  documentFilename?: string;
  docType?: string;
  contentCategory?: string;
}

const AVAILABLE_STRATEGIES = /existing\s+investment\s+strategies\s+of\s+the\s+specialized\s+investment\s+fund/i;
const PRODUCT_OVERVIEW = /^#\s+Platinum Hybrid Long-Short Fund\b/i;
const PRESENTATION_OVERVIEW = /Platinum SIF marks a strategic evolution|Introducing\s+Platinum Hybrid\s+Long-Short Fund/i;
const SAI_OVERVIEW = /^STATEMENT OF ADDITIONAL INFORMATION|This Statement of Additional Information.*Platinum SIF/is;
const KIM_OVERVIEW = /^KEY INFORMATION MEMORANDUM|Name of SIF\s+Platinum SIF/i;

function overviewBoost(candidate: RetrievalRankingCandidate): number {
  const sectionEvidence = `${candidate.sectionHeader ?? ""}\n${candidate.text}`;
  if (AVAILABLE_STRATEGIES.test(sectionEvidence)) return 0.12;
  if (PRODUCT_OVERVIEW.test(candidate.text)) return 0.1;

  const filename = candidate.documentFilename ?? "";
  if (/presentation/i.test(filename) && PRESENTATION_OVERVIEW.test(candidate.text)) return 0.08;
  if (/\bSAI\b/i.test(filename) && SAI_OVERVIEW.test(candidate.text)) return 0.06;
  if ((candidate.docType === "KIM" || /\bKIM\b/i.test(filename)) && KIM_OVERVIEW.test(candidate.text)) return 0.05;
  return 0;
}

export function adjustRetrievalScore(
  candidate: RetrievalRankingCandidate,
  profile?: RetrievalRankingProfile,
): number {
  if (profile !== "mirae_sif_overview") return candidate.score;
  return Math.min(1, candidate.score + overviewBoost(candidate));
}
