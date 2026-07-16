import type { HtmlSearchFilters, SearchFilters } from "@mf-rag/vector";
import type { RetrievalRankingProfile } from "./retrieval-ranking.ts";

export interface RetrievalScopeRequest {
  question: string;
  topic?: string;
  amc_name?: string;
  scheme_name?: string;
  scheme_type?: string;
  doc_type?: string;
  content_category?: string;
}

export interface RetrievalScope {
  pdfFilters: SearchFilters;
  htmlFilters: HtmlSearchFilters;
  searchPdf: boolean;
  searchHtml: boolean;
  rankingProfile?: RetrievalRankingProfile;
}

const SIF_PATTERN = /\bSIF\b|speciali[sz]ed\s+investment\s+fund/i;
const MIRAE_PATTERN = /\bmirae(?:\s+asset)?\b/i;
const PLATINUM_SIF_PATTERN = /\bplatinum\b.*\b(?:fund|long-short|sif)\b/i;
const SIF_UMBRELLA_SCHEME_PATTERN = /^(?:(?:mirae(?:\s+asset)?|platinum)\s+)*(?:sif|speciali[sz]ed\s+investment\s+fund)$/i;
const OVERVIEW_QUESTION_PATTERN = /\b(?:tell me about|overview|what is|which (?:investment )?strateg(?:y|ies)|available strateg(?:y|ies))\b/i;

function isSifUmbrellaSchemeName(schemeName?: string): boolean {
  return SIF_UMBRELLA_SCHEME_PATTERN.test(schemeName?.trim() ?? "");
}

function isSifRequest(request: RetrievalScopeRequest): boolean {
  return request.topic?.trim().toLowerCase() === "sif"
    || SIF_PATTERN.test(request.question)
    || SIF_PATTERN.test(request.scheme_name ?? "")
    || PLATINUM_SIF_PATTERN.test(request.question)
    || PLATINUM_SIF_PATTERN.test(request.scheme_name ?? "");
}

function isMiraeRequest(request: RetrievalScopeRequest): boolean {
  return MIRAE_PATTERN.test(request.amc_name ?? "")
    || MIRAE_PATTERN.test(request.question)
    || PLATINUM_SIF_PATTERN.test(request.question)
    || PLATINUM_SIF_PATTERN.test(request.scheme_name ?? "");
}

function addPdfArguments(
  filters: SearchFilters,
  request: RetrievalScopeRequest
): void {
  if (request.scheme_name && !isSifUmbrellaSchemeName(request.scheme_name)) {
    filters.fund_name = request.scheme_name;
  }
  if (request.scheme_type) filters.scheme_type = request.scheme_type;
  if (request.doc_type) filters.doc_type = request.doc_type;
}

/**
 * Convert agent-facing business concepts into internal retrieval filters.
 * Internal collection names are deliberately derived here and are never
 * accepted as tool arguments.
 */
export function resolveRetrievalScope(
  request: RetrievalScopeRequest
): RetrievalScope {
  const pdfFilters: SearchFilters = {};
  const htmlFilters: HtmlSearchFilters = {};
  addPdfArguments(pdfFilters, request);

  if (request.content_category) {
    htmlFilters.content_category = request.content_category;
  }

  const hasPdfArguments = Boolean(
    pdfFilters.fund_name || request.scheme_type || request.doc_type
  );
  const hasHtmlArguments = Boolean(request.content_category);
  const sifRequest = isSifRequest(request);
  const miraeRequest = isMiraeRequest(request);
  const rankingProfile = sifRequest && miraeRequest && OVERVIEW_QUESTION_PATTERN.test(request.question)
    ? "mirae_sif_overview"
    : undefined;

  if (sifRequest && miraeRequest) {
    pdfFilters.knowledge_domain = "sif";
    pdfFilters.source_collection = "mirae_sif";
    htmlFilters.knowledge_domain = "sif";
    htmlFilters.source_collection = "mirae_sif";
  } else if (sifRequest) {
    htmlFilters.knowledge_domain = "sif";
    htmlFilters.source_collection = "sebi_regulatory";
    htmlFilters.content_category = "regulatory";
  }

  if (hasPdfArguments) {
    return { pdfFilters, htmlFilters, searchPdf: true, searchHtml: false, rankingProfile };
  }

  if (hasHtmlArguments) {
    return { pdfFilters, htmlFilters, searchPdf: false, searchHtml: true, rankingProfile };
  }

  if (sifRequest && !miraeRequest) {
    return { pdfFilters, htmlFilters, searchPdf: false, searchHtml: true, rankingProfile };
  }

  return { pdfFilters, htmlFilters, searchPdf: true, searchHtml: true, rankingProfile };
}
