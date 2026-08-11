import {
  createLogicalDocumentKey,
  type SourceDiscoveryConfig,
} from "@mf-rag/types";

import {
  deterministicSourceConnectorError as deterministic,
  type DiscoveredSourceDocument,
} from "./source-connector.ts";

type ScraperConfig = Extract<SourceDiscoveryConfig, { strategy: "sebi_sid_scraper" }>;
type FetchText = (url: string, accept: string, signal?: AbortSignal) => Promise<string>;
type AssertAllowedDocumentUrl = (url: string) => string;

const SCHEME_ID_PATTERN = /getFundDetails\s*\(\s*['"](\d+)['"]\s*\)/g;
const IFRAME_SRC_PATTERN = /<iframe\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const SCHEME_LIST_BASE =
  "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doGetFundDetails=yes&type=2&mfId=";
// The detail page uses mfdId (not schemeId) and wraps the PDF in a viewer:
// <iframe src='https://www.sebi.gov.in/web/?file=https://...pdf'>
const SCHEME_DETAIL_BASE =
  "https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doGetFundDetails=yes&mfdId=";

export async function discoverSebiSidScraper(
  config: ScraperConfig,
  fetchText: FetchText,
  assertAllowedDocumentUrl: AssertAllowedDocumentUrl,
  signal?: AbortSignal,
): Promise<readonly DiscoveredSourceDocument[]> {
  const schemeListUrl = `${SCHEME_LIST_BASE}${config.mfId}`;
  const schemeListHtml = await fetchText(schemeListUrl, "text/html,application/xhtml+xml", signal);

  const schemeIds = extractSchemeIds(schemeListHtml, config.maxSchemes);

  const documents = new Map<string, DiscoveredSourceDocument>();

  for (const schemeId of schemeIds) {
    if (signal?.aborted) {
      throw deterministic("FETCH_CANCELLED", "Discovery was cancelled.");
    }
    if (documents.size >= config.maxDocuments) break;

    const detailUrl = `${SCHEME_DETAIL_BASE}${schemeId}`;
    const detailHtml = await fetchText(detailUrl, "text/html,application/xhtml+xml", signal);

    const pdfUrl = extractPdfUrl(detailHtml, detailUrl);
    if (!pdfUrl) continue;

    const allowedUrl = assertAllowedDocumentUrl(pdfUrl);
    const logicalDocumentKey = createLogicalDocumentKey(`sebi-sid:${schemeId}`);
    documents.set(schemeId, { logicalDocumentKey, url: allowedUrl });
  }

  if (documents.size < config.minimumDocuments) {
    throw deterministic(
      "SEBI_DOCUMENT_MINIMUM",
      `SEBI SID scraper discovered ${documents.size} PDF documents, below the configured minimum of ${config.minimumDocuments}.`,
    );
  }

  return [...documents.values()].sort((left, right) =>
    String(left.logicalDocumentKey).localeCompare(String(right.logicalDocumentKey)));
}

function extractSchemeIds(html: string, maxSchemes: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  SCHEME_ID_PATTERN.lastIndex = 0;
  while ((match = SCHEME_ID_PATTERN.exec(html)) !== null) {
    const id = match[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
      if (ids.length >= maxSchemes) break;
    }
  }
  return ids;
}

function extractPdfUrl(html: string, baseUrl: string): string | null {
  const match = IFRAME_SRC_PATTERN.exec(html);
  if (!match) return null;

  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!raw) return null;

  let src: URL;
  try {
    src = new URL(raw, baseUrl);
  } catch {
    return null;
  }

  // SEBI wraps PDFs in a viewer: /web/?file=https://...pdf
  // Extract the actual PDF URL from the file= query parameter if present.
  const fileParam = src.searchParams.get("file");
  if (fileParam) {
    try {
      const pdfUrl = new URL(fileParam);
      return pdfUrl.pathname.toLowerCase().endsWith(".pdf") ? pdfUrl.href : null;
    } catch {
      return null;
    }
  }

  // Fallback: iframe src is the PDF directly
  return src.pathname.toLowerCase().endsWith(".pdf") ? src.href : null;
}
