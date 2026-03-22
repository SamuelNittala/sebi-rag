#!/usr/bin/env bun
/**
 * HTML Content Scraper CLI
 *
 * Usage:
 *   bun run apps/scraper/src/scrape-html.ts [--source <name>] [--verbose]
 *
 * Scrapes configured HTML sources and stores as markdown files.
 */

import { HtmlScraper } from "./html-scraper.ts";
import { allAmfiSources } from "./sources/amfi.ts";

async function main() {
  const args = process.argv.slice(2);
  const sourceFilter = args.includes("--source") ? args[args.indexOf("--source") + 1] : undefined;

  const sources = sourceFilter
    ? allAmfiSources.filter((s) => s.name === sourceFilter)
    : allAmfiSources;

  if (sources.length === 0) {
    console.error(`No source found matching "${sourceFilter}"`);
    console.error(`Available sources: ${allAmfiSources.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  const scraper = new HtmlScraper();

  let totalOk = 0;
  let totalFail = 0;

  for (const source of sources) {
    const result = await scraper.scrapeSource(source);
    totalOk += result.succeeded;
    totalFail += result.failed;
  }

  console.log(`\n--- Scrape Complete ---`);
  console.log(`Succeeded: ${totalOk}`);
  console.log(`Failed: ${totalFail}`);

  if (totalFail > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
