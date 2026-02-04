#!/usr/bin/env bun
/**
 * SEBI Mutual Fund Scraper CLI
 *
 * Commands:
 *   scrape   - Scrape AMC and scheme metadata
 *   download - Download PDFs for scraped schemes
 *   status   - Show current scrape/download progress
 *   reset    - Clear state and start fresh
 *   help     - Show help message
 */

import { SebiScraper } from "./scraper";
import type { CliCommand, CliOptions, ScraperConfig } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { resolve } from "path";

// Parse command line arguments
function parseArgs(): { command: CliCommand; options: CliOptions } {
  const args = process.argv.slice(2);
  const command = (args[0] || "help") as CliCommand;
  const options: CliOptions = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit" && args[i + 1]) {
      options.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    }
  }

  return { command, options };
}

// Show help message
function showHelp(): void {
  console.log(`
SEBI Mutual Fund Scraper

Usage: bun run apps/scraper/src/index.ts <command> [options]

Commands:
  scrape     Scrape AMC and scheme metadata from SEBI
  download   Download PDFs for scraped schemes
  status     Show current scrape/download progress
  reset      Clear state and start fresh
  help       Show this help message

Options:
  --limit N    Only process first N items (for testing)
  --verbose    Show detailed progress output
  --force      Force re-download of existing files
  --dry-run    Show what would be done without doing it

Examples:
  # Full scrape and download
  bun run apps/scraper/src/index.ts scrape
  bun run apps/scraper/src/index.ts download

  # Test with limited items
  bun run apps/scraper/src/index.ts scrape --limit 5 --verbose

  # Check progress
  bun run apps/scraper/src/index.ts status

  # Start fresh
  bun run apps/scraper/src/index.ts reset
`);
}

// Get configuration from environment or defaults
function getConfig(): ScraperConfig {
  const projectRoot = resolve(import.meta.dir, "../../../..");

  return {
    request: {
      ...DEFAULT_CONFIG.request,
      delayMs: parseInt(process.env.SCRAPER_DELAY_MS || "500", 10),
    },
    download: {
      ...DEFAULT_CONFIG.download,
      concurrency: parseInt(process.env.SCRAPER_CONCURRENCY || "3", 10),
      outputDir: process.env.SCRAPER_OUTPUT_DIR || resolve(projectRoot, "data/sebi-pdfs"),
    },
    state: {
      ...DEFAULT_CONFIG.state,
      statePath: process.env.SCRAPER_STATE_PATH || resolve(projectRoot, "data/scrape-state.json"),
    },
  };
}

// Main function
async function main(): Promise<void> {
  const { command, options } = parseArgs();

  if (command === "help") {
    showHelp();
    return;
  }

  const config = getConfig();
  const scraper = new SebiScraper(config);

  try {
    switch (command) {
      case "scrape": {
        console.log("Starting metadata scrape...\n");

        const result = await scraper.scrapeMetadata({
          limit: options.limit,
          verbose: options.verbose ?? true,
        });

        console.log("\n--- Scrape Complete ---");
        console.log(`AMCs found: ${result.amcs.length}`);
        console.log(`Total schemes: ${result.totalSchemes}`);

        if (result.errors.length > 0) {
          console.log(`\nErrors (${result.errors.length}):`);
          for (const error of result.errors.slice(0, 10)) {
            console.log(`  - ${error}`);
          }
          if (result.errors.length > 10) {
            console.log(`  ... and ${result.errors.length - 10} more`);
          }
        }
        break;
      }

      case "download": {
        console.log("Starting PDF downloads...\n");

        const result = await scraper.downloadPdfs({
          limit: options.limit,
          verbose: options.verbose ?? true,
        });

        console.log("\n--- Download Complete ---");
        console.log(`Attempted: ${result.attempted}`);
        console.log(`Succeeded: ${result.succeeded}`);
        console.log(`Failed: ${result.failed}`);
        console.log(`Skipped (no PDF): ${result.skipped}`);

        if (result.errors.length > 0) {
          console.log(`\nErrors (${result.errors.length}):`);
          for (const error of result.errors.slice(0, 10)) {
            console.log(`  - ${error}`);
          }
          if (result.errors.length > 10) {
            console.log(`  ... and ${result.errors.length - 10} more`);
          }
        }
        break;
      }

      case "status": {
        const status = await scraper.getStatus();

        console.log("--- Scraper Status ---");
        console.log(`Phase: ${status.phase}`);
        console.log(`Last updated: ${status.lastUpdated}`);
        console.log();
        console.log("Statistics:");
        console.log(`  Total AMCs: ${status.stats.totalAmcs}`);
        console.log(`  Total schemes: ${status.stats.totalSchemes}`);
        console.log(`  Downloaded PDFs: ${status.stats.downloadedPdfs}`);
        console.log(`  Failed downloads: ${status.stats.failedDownloads}`);
        console.log(`  Schemes without PDF: ${status.stats.noPdfUrl}`);
        console.log();
        console.log("Pending:");
        console.log(`  AMCs to scrape: ${status.pendingAmcs}`);
        console.log(`  Schemes to download: ${status.pendingSchemes}`);
        break;
      }

      case "reset": {
        console.log("Resetting scraper state...");
        await scraper.resetState();
        console.log("State cleared. Downloaded PDFs were NOT deleted.");
        console.log("Run 'scrape' to start fresh.");
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log("Run 'help' for available commands.");
        process.exit(1);
    }
  } finally {
    scraper.cleanup();
  }
}

// Run main
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
