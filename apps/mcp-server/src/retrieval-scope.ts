import type { HtmlSearchFilters, SearchFilters } from "@mf-rag/vector";
import {
  miraeSifStrategies,
  miraeSifUmbrellaAliases,
} from "@mf-rag/core/metadata-review";
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
  allowFundFilterFallback: boolean;
  rankingProfile?: RetrievalRankingProfile;
}

const SIF_PATTERN = /\bSIFs?\b|speciali[sz]ed\s+investment\s+funds?\b/i;
const MIRAE_PATTERN = /\bmirae(?:\s+asset)?\b/i;
const OVERVIEW_QUESTION_PATTERN = /\b(?:tell me about|overview|what is|which (?:investment )?strateg(?:y|ies)|available strateg(?:y|ies))\b/i;
const FUND_MANAGER_QUESTION_PATTERN = /\b(?:fund manager|who manages)\b/i;

function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function containsAlias(value: string, alias: string): boolean {
  return ` ${normalizeAlias(value)} `.includes(` ${normalizeAlias(alias)} `);
}

function resolveManifestStrategy(...values: Array<string | undefined>) {
  return miraeSifStrategies.find((strategy) => values.some((value) =>
    Boolean(value && strategy.aliases.some((alias) => containsAlias(value, alias)))
  ));
}

function isSifUmbrellaSchemeName(schemeName?: string): boolean {
  const normalized = normalizeAlias(schemeName ?? "");
  return miraeSifUmbrellaAliases.some((alias) => normalizeAlias(alias) === normalized);
}

function isSifRequest(
  request: RetrievalScopeRequest,
  hasManifestTarget: boolean,
): boolean {
  return request.topic?.trim().toLowerCase() === "sif"
    || SIF_PATTERN.test(request.question)
    || SIF_PATTERN.test(request.scheme_name ?? "")
    || hasManifestTarget;
}

function isMiraeRequest(
  request: RetrievalScopeRequest,
  hasManifestTarget: boolean,
): boolean {
  return MIRAE_PATTERN.test(request.amc_name ?? "")
    || MIRAE_PATTERN.test(request.question)
    || hasManifestTarget;
}

function addPdfArguments(
  filters: SearchFilters,
  request: RetrievalScopeRequest,
  canonicalStrategyName?: string,
): void {
  if (request.scheme_name && !isSifUmbrellaSchemeName(request.scheme_name)) {
    filters.fund_name = canonicalStrategyName ?? request.scheme_name;
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
  const manifestStrategy = resolveManifestStrategy(request.question, request.scheme_name);
  addPdfArguments(pdfFilters, request, manifestStrategy?.name);

  if (request.content_category) {
    htmlFilters.content_category = request.content_category;
  }

  const hasPdfArguments = Boolean(
    pdfFilters.fund_name || request.scheme_type || request.doc_type
  );
  const hasHtmlArguments = Boolean(request.content_category);
  const hasManifestTarget = Boolean(manifestStrategy);
  const sifRequest = isSifRequest(request, hasManifestTarget);
  const miraeRequest = isMiraeRequest(request, hasManifestTarget);
  const rankingProfile = sifRequest && miraeRequest
    ? FUND_MANAGER_QUESTION_PATTERN.test(request.question)
      ? "mirae_sif_fund_manager"
      : OVERVIEW_QUESTION_PATTERN.test(request.question)
        ? "mirae_sif_overview"
        : undefined
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
    return {
      pdfFilters,
      htmlFilters,
      searchPdf: true,
      searchHtml: false,
      allowFundFilterFallback: hasManifestTarget && Boolean(pdfFilters.source_collection),
      rankingProfile,
    };
  }

  if (hasHtmlArguments) {
    return { pdfFilters, htmlFilters, searchPdf: false, searchHtml: true, allowFundFilterFallback: false, rankingProfile };
  }

  if (sifRequest && !miraeRequest) {
    return { pdfFilters, htmlFilters, searchPdf: false, searchHtml: true, allowFundFilterFallback: false, rankingProfile };
  }

  return { pdfFilters, htmlFilters, searchPdf: true, searchHtml: true, allowFundFilterFallback: false, rankingProfile };
}
