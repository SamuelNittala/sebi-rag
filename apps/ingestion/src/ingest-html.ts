#!/usr/bin/env bun
/**
 * HTML Content Ingestion CLI
 *
 * Usage:
 *   bun run apps/ingestion/src/ingest-html.ts [--dir <path>]
 *
 * Ingests stored .md files from data/html-sources/ into html_chunks table.
 */

import { resolve } from "path";
import { ingestHtmlDirectory } from "./orchestrator/ingest-html.ts";

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const defaultDir = resolve(import.meta.dir, "../../..", "data/html-sources");
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultDir;

  console.log(`Ingesting HTML content from ${dir}\n`);

  const results = await ingestHtmlDirectory(dir);

  const completed = results.filter((r) => r.status === "completed");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");
  const totalChunks = completed.reduce((sum, r) => sum + (r.chunkCount ?? 0), 0);

  console.log(`\n--- Ingestion Complete ---`);
  console.log(`Completed: ${completed.length} (${totalChunks} chunks)`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed) {
      console.log(`  ${f.filename}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
