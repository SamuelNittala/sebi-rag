/**
 * Ingest 1 PDF from each AMC folder for testing
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { ingestDocument } from "../apps/ingestion/src/orchestrator/ingest";

const SEBI_PDFS_DIR = "./data/sebi-pdfs";

async function ingestSample() {
  console.log("Selecting 1 PDF from each AMC folder...\n");

  const amcFolders = readdirSync(SEBI_PDFS_DIR).filter(dir => {
    const dirPath = join(SEBI_PDFS_DIR, dir);
    return statSync(dirPath).isDirectory();
  });

  console.log(`Found ${amcFolders.length} AMC folders\n`);

  const pdfsToIngest: string[] = [];

  for (const amcFolder of amcFolders) {
    const amcPath = join(SEBI_PDFS_DIR, amcFolder);
    const files = readdirSync(amcPath).filter(f => f.endsWith(".pdf"));

    if (files.length > 0) {
      // Pick first PDF from each folder
      pdfsToIngest.push(join(amcPath, files[0]));
    }
  }

  console.log(`Selected ${pdfsToIngest.length} PDFs for ingestion\n`);
  console.log("=".repeat(80));

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < pdfsToIngest.length; i++) {
    const pdfPath = pdfsToIngest[i];
    const fileName = pdfPath.split("/").pop()!;
    const amcName = pdfPath.split("/").slice(-2, -1)[0];

    console.log(`\n[${i + 1}/${pdfsToIngest.length}] ${amcName}`);
    console.log(`  ${fileName}`);

    try {
      const result = await ingestDocument(pdfPath, {
        ollamaUrl: "http://localhost:11434",
      }, (progress) => {
        if (progress.percentage && progress.percentage % 20 === 0) {
          console.log(`  ${progress.stage}: ${progress.percentage}%`);
        }
      });

      if (result.status === "completed") {
        successCount++;
        console.log(`  ✓ Success: ${result.chunkCount} chunks`);
      } else if (result.status === "skipped") {
        skippedCount++;
        console.log(`  ⊘ Skipped: already processed`);
      } else {
        failCount++;
        console.log(`  ✗ Failed: ${result.error}`);
      }
    } catch (error) {
      failCount++;
      console.log(`  ✗ Error: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("Ingestion Summary");
  console.log("=".repeat(80));
  console.log(`Total processed: ${pdfsToIngest.length}`);
  console.log(`Successful:      ${successCount}`);
  console.log(`Skipped:         ${skippedCount}`);
  console.log(`Failed:          ${failCount}`);
  console.log("=".repeat(80));
}

ingestSample().catch(console.error);
