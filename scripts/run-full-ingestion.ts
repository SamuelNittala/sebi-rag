#!/usr/bin/env bun
/**
 * Run full PDF ingestion with progress tracking.
 * Processes all PDFs in sebi-pdfs directory sequentially.
 */

import { readdirSync } from "fs";
import { join, basename } from "path";
import { ingestDocument } from "../apps/ingestion/src/orchestrator/ingest.ts";
import { db } from "../packages/db/src/client.ts";
import { documents, chunks } from "../packages/db/src/schema.ts";
import { sql, eq } from "drizzle-orm";

const SEBI_PDFS_DIR = "./data/sebi-pdfs";
const OLLAMA_URL = "http://localhost:11434";

// Get stats
async function getStats() {
  const docCount = await db.select({ count: sql<number>`count(*)` }).from(documents);
  const completedCount = await db.select({ count: sql<number>`count(*)` }).from(documents).where(eq(documents.status, "completed"));
  const chunkCount = await db.select({ count: sql<number>`count(*)` }).from(chunks);
  return {
    total: docCount[0].count,
    completed: completedCount[0].count,
    chunks: chunkCount[0].count,
  };
}

async function main() {
  console.log("=== Full PDF Ingestion ===\n");

  // Get all PDFs recursively
  const glob = new Bun.Glob("**/*.pdf");
  const pdfs: string[] = [];

  for await (const file of glob.scan({ cwd: SEBI_PDFS_DIR, absolute: true })) {
    pdfs.push(file);
  }

  console.log(`Found ${pdfs.length} PDFs to process\n`);

  const startStats = await getStats();
  console.log(`Starting state: ${startStats.completed} completed, ${startStats.chunks} chunks\n`);

  let completed = 0;
  let skipped = 0;
  let failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < pdfs.length; i++) {
    const pdfPath = pdfs[i];
    const filename = basename(pdfPath);
    const amcFolder = pdfPath.split("/").slice(-2, -1)[0];

    process.stdout.write(`[${i + 1}/${pdfs.length}] ${amcFolder}/${filename.slice(0, 40)}... `);

    try {
      const result = await ingestDocument(pdfPath, { ollamaUrl: OLLAMA_URL });

      if (result.status === "completed") {
        completed++;
        console.log(`✓ ${result.chunkCount} chunks (${(result.duration! / 1000).toFixed(1)}s)`);
      } else if (result.status === "skipped") {
        skipped++;
        console.log("○ skipped (already processed)");
      } else {
        failed++;
        console.log(`✗ ${result.error?.slice(0, 50)}`);
      }
    } catch (error) {
      failed++;
      console.log(`✗ ${error instanceof Error ? error.message.slice(0, 50) : "Unknown error"}`);
    }

    // Progress update every 50 files
    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - startTime) / 1000 / 60;
      const rate = (completed + skipped) / elapsed;
      const remaining = pdfs.length - i - 1;
      const eta = remaining / rate;
      console.log(`\n--- Progress: ${completed} completed, ${skipped} skipped, ${failed} failed | ETA: ${eta.toFixed(0)} min ---\n`);
    }
  }

  const endStats = await getStats();
  const elapsed = (Date.now() - startTime) / 1000 / 60;

  console.log("\n=== Summary ===");
  console.log(`Completed: ${completed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total time: ${elapsed.toFixed(1)} minutes`);
  console.log(`Final state: ${endStats.completed} documents, ${endStats.chunks} chunks`);
}

main().catch(console.error);
