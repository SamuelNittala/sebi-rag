#!/usr/bin/env bun
/**
 * Ingest one PDF from each AMC folder for testing pgvector migration.
 * Skips AMCs that already have documents ingested.
 */

import { readdirSync } from "fs";
import { join } from "path";
import { ingestDocument } from "../apps/ingestion/src/orchestrator/index.ts";
import { db } from "../packages/db/src/client.ts";
import { chunks } from "../packages/db/src/schema.ts";
import { sql } from "drizzle-orm";

const SEBI_PDFS_DIR = "data/sebi-pdfs";
const OLLAMA_URL = "http://localhost:11434";

async function getIngestedFunds(): Promise<Set<string>> {
  const result = await db
    .selectDistinct({ fundName: chunks.fundName })
    .from(chunks);
  return new Set(result.map((r) => r.fundName));
}

async function main() {
  console.log("Checking already ingested funds...");
  const ingestedFunds = await getIngestedFunds();
  console.log(`Already ingested: ${ingestedFunds.size} funds\n`);

  // Get all AMC folders
  const amcFolders = readdirSync(SEBI_PDFS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`Found ${amcFolders.length} AMC folders\n`);

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const amc of amcFolders) {
    const amcPath = join(SEBI_PDFS_DIR, amc);

    // Get first PDF in folder
    const pdfs = readdirSync(amcPath).filter((f) => f.endsWith(".pdf"));
    if (pdfs.length === 0) {
      console.log(`[SKIP] ${amc}: No PDFs found`);
      skipped++;
      continue;
    }

    const pdfPath = join(amcPath, pdfs[0]);
    const fundNameGuess = pdfs[0].replace(".pdf", "");

    // Check if any fund from this AMC is already ingested
    // (simple heuristic: check if fund name contains AMC name pattern)
    const amcPattern = amc.replace(/_/g, " ").replace(" Mutual Fund", "");
    const alreadyHasAmc = [...ingestedFunds].some((f) =>
      f.toLowerCase().includes(amcPattern.toLowerCase().split(" ")[0])
    );

    if (alreadyHasAmc) {
      console.log(`[SKIP] ${amc}: Already has fund ingested`);
      skipped++;
      continue;
    }

    console.log(`[INGEST] ${amc}: ${pdfs[0]}`);

    try {
      const result = await ingestDocument(pdfPath, { ollamaUrl: OLLAMA_URL }, (progress) => {
        if (progress.percentage && progress.percentage % 20 === 0) {
          process.stdout.write(`  ${progress.percentage}%...`);
        }
      });

      if (result.status === "completed") {
        console.log(` Done (${result.chunkCount} chunks)`);
        ingestedFunds.add(fundNameGuess);
        ingested++;
      } else if (result.status === "skipped") {
        console.log(` Skipped (duplicate)`);
        skipped++;
      } else {
        console.log(` Failed: ${result.error}`);
        failed++;
      }
    } catch (error) {
      console.log(` Error: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Ingested: ${ingested}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total chunks: ${(await db.select({ count: sql<number>`count(*)` }).from(chunks))[0].count}`);
}

main().catch(console.error);
