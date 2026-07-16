import type { HtmlSourceConfig } from "../html-scraper.ts";

export const miraeSifFund: HtmlSourceConfig = {
  name: "mirae-sif",
  contentCategory: "product",
  contentSelector: "main, #main-content",
  pages: [
    {
      url: "https://platinumsif.miraeassetmf.co.in/fund?schemeCode=3166",
      slug: "platinum-hybrid-long-short-fund",
    },
  ],
};

export const allMiraeSifSources: HtmlSourceConfig[] = [miraeSifFund];
