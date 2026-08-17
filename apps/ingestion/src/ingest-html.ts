#!/usr/bin/env bun
/**
 * HTML Content Ingestion CLI
 *
 * Usage:
 *   bun run apps/ingestion/src/ingest-html.ts --tenant-id <id>
 *     --ownership-manifest-id <id> --ownership-manifest-version <n> [--dir <path>]
 *
 * Ingests stored .md files from data/html-sources/ into html_chunks table.
 */

import { resolve } from "path";
import { ingestHtmlDirectory } from "./orchestrator/ingest-html.ts";

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const tenantId = requiredFlag(args, "--tenant-id");
  const ownershipManifestId = requiredFlag(args, "--ownership-manifest-id");
  const ownershipManifestVersion = Number(requiredFlag(args, "--ownership-manifest-version"));
  if (!Number.isInteger(ownershipManifestVersion) || ownershipManifestVersion <= 0) {
    throw new Error("--ownership-manifest-version must be a positive integer.");
  }
  const defaultDir = resolve(import.meta.dir, "../../..", "data/html-sources");
  const dir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : defaultDir;

  console.log(`Ingesting HTML content from ${dir}\n`);

  const results = await ingestHtmlDirectory(dir, {
    reviewGate: "required",
    ownership: {
      visibilityScope: "TENANT",
      tenantId,
      ownershipManifestId,
      ownershipManifestVersion,
    },
  });

  const completed = results.filter((r) => r.status === "completed");
  const skipped = results.filter((r) => r.status === "skipped");
  const reviewRequired = results.filter((r) => r.status === "review_required");
  const failed = results.filter((r) => r.status === "failed");
  const totalChunks = completed.reduce((sum, r) => sum + (r.chunkCount ?? 0), 0);

  console.log(`\n--- Ingestion Complete ---`);
  console.log(`Completed: ${completed.length} (${totalChunks} chunks)`);
  console.log(`Skipped: ${skipped.length}`);
  console.log(`Review required: ${reviewRequired.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed) {
      console.log(`  ${f.filename}: ${f.error}`);
    }
    process.exit(1);
  }
}

function requiredFlag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
