/**
 * Re-ingest all 53 test PDFs (1 per AMC) with updated metadata extraction
 *
 * Updates:
 * - AMC names extracted from folder paths (not PDF text)
 * - Database lookups for authoritative metadata
 * - Proper scheme types from SEBI data
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { ingestDocument } from "../apps/ingestion/src/orchestrator/ingest";
import { db, documents, chunks, eq } from "@mf-rag/db";
import { VectorClient } from "@mf-rag/vector";

const SEBI_PDFS_DIR = "./data/sebi-pdfs";

async function reingestAll53Pdfs() {
  console.log("Re-ingesting 53 PDFs with updated metadata extraction...\n");

  // Step 1: Find all PDFs (1 per AMC folder)
  console.log("Scanning AMC folders...");

  const amcFolders = readdirSync(SEBI_PDFS_DIR).filter((dir) => {
    const dirPath = join(SEBI_PDFS_DIR, dir);
    return statSync(dirPath).isDirectory();
  });

  console.log(`Found ${amcFolders.length} AMC folders\n`);

  const pdfsToIngest: string[] = [];

  for (const amcFolder of amcFolders) {
    const amcPath = join(SEBI_PDFS_DIR, amcFolder);
    const files = readdirSync(amcPath).filter((f) => f.endsWith(".pdf"));

    if (files.length > 0) {
      // Pick first PDF from each folder
      pdfsToIngest.push(join(amcPath, files[0]));
    }
  }

  console.log(`Selected ${pdfsToIngest.length} PDFs for re-ingestion\n`);

  // Step 2: Clean up existing documents and chunks
  console.log("Cleaning up existing documents and chunks...");

  const vector = new VectorClient();
  await vector.initCollection();

  let deletedDocs = 0;
  let deletedChunks = 0;

  for (const pdfPath of pdfsToIngest) {
    const filename = pdfPath.split("/").pop()!;

    // Find document by filename
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.filename, filename));

    for (const doc of docs) {
      // Delete chunks from database
      const deleted = await vector.deleteByDocumentId(doc.id);
      if (deleted > 0) {
        deletedChunks++;
      }

      // Delete document from database
      await db.delete(documents).where(eq(documents.id, doc.id));
      deletedDocs++;
    }
  }

  console.log(`  Deleted ${deletedDocs} documents`);
  console.log(`  Deleted chunks for ${deletedChunks} documents\n`);

  // Step 3: Re-ingest all PDFs
  console.log("=".repeat(80));
  console.log("Starting re-ingestion...");
  console.log("=".repeat(80));
  console.log();

  let successCount = 0;
  let failCount = 0;
  let totalChunks = 0;

  for (let i = 0; i < pdfsToIngest.length; i++) {
    const pdfPath = pdfsToIngest[i];
    const fileName = pdfPath.split("/").pop()!;
    const amcName = pdfPath.split("/").slice(-2, -1)[0];

    console.log(`[${i + 1}/${pdfsToIngest.length}] ${amcName}`);
    console.log(`  ${fileName}`);

    try {
      const result = await ingestDocument(
        pdfPath,
        {
          ollamaUrl: "http://localhost:11434",
        },
        (progress) => {
          if (progress.percentage && progress.percentage % 20 === 0) {
            console.log(`  ${progress.stage}: ${progress.percentage}%`);
          }
        }
      );

      if (result.status === "completed") {
        successCount++;
        totalChunks += result.chunkCount || 0;
        console.log(`  ✓ Success: ${result.chunkCount} chunks`);
      } else if (result.status === "skipped") {
        console.log(`  ⊘ Skipped: already processed`);
      } else {
        failCount++;
        console.log(`  ✗ Failed: ${result.error}`);
      }
    } catch (error) {
      failCount++;
      console.log(
        `  ✗ Error: ${error instanceof Error ? error.message : error}`
      );
    }

    console.log();
  }

  console.log("=".repeat(80));
  console.log("Re-ingestion Summary");
  console.log("=".repeat(80));
  console.log(`Total processed: ${pdfsToIngest.length}`);
  console.log(`Successful:      ${successCount}`);
  console.log(`Failed:          ${failCount}`);
  console.log(`Total chunks:    ${totalChunks}`);
  console.log("=".repeat(80));
  console.log();

  // Step 4: Verify metadata quality
  console.log("Verifying metadata quality...\n");

  const sampleChunks = await db
    .select({ amcName: chunks.amcName })
    .from(chunks)
    .limit(10);

  let correctAmcCount = 0;
  let theAmcCount = 0;

  for (const chunk of sampleChunks) {
    const amcName = chunk.amcName;
    if (amcName && amcName !== "The AMC" && !amcName.includes("Asset Management Company")) {
      correctAmcCount++;
    } else if (amcName === "The AMC") {
      theAmcCount++;
    }
  }

  console.log(`Sample of 10 chunks:`);
  console.log(`  Correct AMC names: ${correctAmcCount}/10`);
  console.log(`  "The AMC" (wrong):  ${theAmcCount}/10`);

  if (theAmcCount > 0) {
    console.log(`\n⚠️  Warning: Some chunks still have "The AMC" - check logs above for failures`);
  } else {
    console.log(`\n✓ All sample chunks have proper AMC names!`);
  }
}

reingestAll53Pdfs().catch((error) => {
  console.error("Re-ingestion failed:", error);
  process.exit(1);
});
