import { load as cheerioLoad } from "cheerio";

import type { HtmlSourceConfig } from "../html-scraper.ts";

const MIRAE_MF_BASE = "https://www.miraeassetmf.co.in";
const SCHEME_INDEX = `${MIRAE_MF_BASE}/mutual-fund-scheme`;
const MINIMUM_SCHEME_PAGES = 50;
const MAXIMUM_SCHEME_PAGES = 100;

export function extractMiraeMfSchemePages(html: string): HtmlSourceConfig["pages"] {
  const $ = cheerioLoad(html);
  const paths = new Set<string>();
  $('a[href^="/mutual-fund-scheme/"]').each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = new URL(href, MIRAE_MF_BASE);
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.origin !== MIRAE_MF_BASE || segments.length !== 3 || segments[0] !== "mutual-fund-scheme") return;
    paths.add(url.pathname);
  });

  if (paths.size < MINIMUM_SCHEME_PAGES || paths.size > MAXIMUM_SCHEME_PAGES) {
    throw new Error(
      `Mirae MF scheme index returned ${paths.size} detail pages; expected ${MINIMUM_SCHEME_PAGES}-${MAXIMUM_SCHEME_PAGES}.`,
    );
  }
  return [...paths].sort().map((path) => ({
    url: `${MIRAE_MF_BASE}${path}`,
    slug: path.split("/").at(-1)!,
  }));
}

export async function discoverMiraeMfSchemeSource(
  fetchImpl: typeof fetch = fetch,
): Promise<HtmlSourceConfig> {
  const response = await fetchImpl(SCHEME_INDEX, {
    headers: {
      "User-Agent": "mf-rag-document-pipeline/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`Mirae MF scheme index returned HTTP ${response.status}.`);
  return {
    name: "mirae-mf-schemes",
    contentCategory: "product",
    contentSelector: "#nav-summary",
    delayMs: 500,
    pages: [
      {
        url: SCHEME_INDEX,
        slug: "current-scheme-overview",
        title: "Mirae Asset Mutual Fund current scheme overview",
      },
      ...extractMiraeMfSchemePages(await response.text()),
    ],
  };
}
