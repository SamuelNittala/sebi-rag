/**
 * HTML Parsers for SEBI Mutual Fund Database
 *
 * Uses Cheerio to extract AMC, scheme, and PDF information from SEBI HTML pages.
 */

import * as cheerio from "cheerio";
import type {
  AMC,
  Scheme,
  AmcListParseResult,
  SchemeListParseResult,
  PdfUrlParseResult,
} from "./types";

const SEBI_BASE_URL = "https://www.sebi.gov.in";

/**
 * Extracts SEBI ID from JavaScript onclick/href patterns
 * Handles patterns like: javascript:viewMF('MF001'), viewMF("MF002"), onclick="viewMF('MF003')"
 */
function extractSebiId(
  element: cheerio.Cheerio<cheerio.Element>,
  pattern: RegExp
): string | null {
  // Check href attribute
  const href = element.attr("href") || "";
  let match = href.match(pattern);
  if (match) return match[1];

  // Check onclick attribute
  const onclick = element.attr("onclick") || "";
  match = onclick.match(pattern);
  if (match) return match[1];

  return null;
}

/**
 * Parses the AMC list HTML from SEBI's mutual fund database
 *
 * Expected HTML structure:
 * <table class="mfClass">
 *   <tr><td><a href="javascript:viewMF('MF001')">AMC Name</a></td></tr>
 * </table>
 */
export function parseAmcList(html: string): AmcListParseResult {
  const $ = cheerio.load(html);
  const amcs: AMC[] = [];
  const errors: string[] = [];

  // Pattern to extract AMC ID from getMutualFund calls
  // Example: getMutualFund('2', '116')
  const idPattern = /getMutualFund\s*\(\s*['"]2['"]\s*,\s*['"]([^'"]+)['"]\s*\)/;

  // Find all links with getMutualFund pattern
  $("table a").each((_, element) => {
    const $el = $(element);
    const sebiId = extractSebiId($el, idPattern);

    if (sebiId) {
      // AMC name is in the previous <td> with class "mutual" in the same row
      const $row = $el.closest("tr");
      const name = $row.find("td.mutual").text().trim().replace(/\s+/g, " ");

      if (name) {
        amcs.push({ sebiId, name });
      }
    }
  });

  return { amcs, errors };
}

/**
 * Parses the scheme list HTML for a given AMC
 *
 * Expected HTML structure:
 * <table class="schemeClass">
 *   <tr><td><a href="javascript:viewScheme('SCH001')">Scheme Name</a></td></tr>
 * </table>
 */
export function parseSchemeList(
  html: string,
  amcId: string,
  amcName: string
): SchemeListParseResult {
  const $ = cheerio.load(html);
  const schemes: Scheme[] = [];
  const errors: string[] = [];

  // Pattern to extract scheme ID from getFundDetails calls
  // Example: getFundDetails('16961')
  const idPattern = /getFundDetails\s*\(\s*['"]([^'"]+)['"]\s*\)/;

  // Find all links in tables
  $("table a").each((_, element) => {
    const $el = $(element);
    const sebiSchemeId = extractSebiId($el, idPattern);

    if (sebiSchemeId) {
      const name = $el.text().trim().replace(/\s+/g, " ");
      if (name) {
        schemes.push({
          sebiSchemeId,
          sebiFundId: amcId,
          name,
          amcName,
        });
      }
    }
  });

  return { schemes, errors };
}

/**
 * Extracts the PDF URL from a scheme detail page
 *
 * Expected HTML structure:
 * <iframe src="https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/document.pdf"></iframe>
 *
 * or relative:
 * <iframe src="/sebi_data/mutualfundfile/jan-2026/document.pdf"></iframe>
 */
export function parsePdfUrl(html: string): PdfUrlParseResult {
  const $ = cheerio.load(html);

  // Find all iframes
  const iframes = $("iframe");

  for (let i = 0; i < iframes.length; i++) {
    const src = $(iframes[i]).attr("src");
    if (src && src.toLowerCase().includes(".pdf")) {
      // Convert relative URL to absolute
      let url = src;
      if (src.startsWith("/")) {
        url = `${SEBI_BASE_URL}${src}`;
      }
      return { url };
    }
  }

  return { url: null };
}

/**
 * Alternative: look for PDF links in anchor tags
 */
export function parsePdfLinks(html: string): string[] {
  const $ = cheerio.load(html);
  const pdfUrls: string[] = [];

  $("a").each((_, element) => {
    const href = $(element).attr("href");
    if (href && href.toLowerCase().includes(".pdf")) {
      let url = href;
      if (href.startsWith("/")) {
        url = `${SEBI_BASE_URL}${href}`;
      }
      pdfUrls.push(url);
    }
  });

  return pdfUrls;
}
