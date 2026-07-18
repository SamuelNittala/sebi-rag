import type { DocumentScope } from "@mf-rag/types";

export interface DocumentScopeInput {
  filename: string;
  documentType: string | null;
  sourceCollection: string;
  fundName: string | null;
}

export interface SectionClassification {
  sectionType: string | null;
  factType: string | null;
}

export function classifyDocumentScope(input: DocumentScopeInput): DocumentScope {
  if (input.sourceCollection === "sebi_regulatory") return "regulatory";
  if (/\bSAI(?:\b|[-_])/i.test(input.filename) || input.documentType === "SAI") {
    return input.sourceCollection === "mirae_sif" ? "sif_umbrella" : "amc";
  }
  if (input.sourceCollection === "mirae_sif" && /(?:ISID|KIM|FAQ|One[- ]?Pager|Four[- ]?Pager|Presentation)/i.test(input.filename)) {
    return "strategy";
  }
  if (input.fundName?.trim()) return "strategy";
  return "unknown";
}

export function classifySection(
  sectionHeader: string | null,
  documentScope: DocumentScope,
): SectionClassification {
  if (!sectionHeader) return { sectionType: null, factType: null };
  if (/who\s+manages\s+the\s+investment\s+strategy/i.test(sectionHeader)) {
    return { sectionType: "strategy_management", factType: "fund_manager" };
  }
  if (/^fund\s+manager$/i.test(sectionHeader.trim())) {
    return documentScope === "strategy"
      ? { sectionType: "strategy_management", factType: "fund_manager" }
      : { sectionType: "staff_directory", factType: null };
  }
  return { sectionType: null, factType: null };
}

export function strategyIdFromName(fundName: string | null): string | null {
  if (!fundName?.trim()) return null;
  return fundName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function strategyIdForScope(
  documentScope: DocumentScope,
  fundName: string | null,
): string | null {
  return documentScope === "strategy" ? strategyIdFromName(fundName) : null;
}
