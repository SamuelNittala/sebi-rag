/**
 * Test ingestion with NaN fix on a previously failed PDF
 */

import { ingestDocument } from "../apps/ingestion/src/orchestrator/ingest";

async function testFixedIngestion() {
  const testPdf = "./data/sebi-pdfs/Motilal_Oswal_Mutual_Fund/Motilal Oswal Small Cap Fund.pdf";

  console.log("Testing ingestion with NaN fix...");
  console.log("PDF:", testPdf);
  console.log();

  const result = await ingestDocument(
    testPdf,
    {
      ollamaUrl: "http://localhost:11434",
    },
    (progress) => {
      if (progress.percentage && progress.percentage % 20 === 0) {
        console.log(`  ${progress.stage}: ${progress.percentage}%`);
      }
    }
  );

  console.log("\nResult:", result);

  if (result.status === "completed") {
    console.log(`✓ Success! Chunks created: ${result.chunkCount}`);
  } else {
    console.log(`✗ Failed: ${result.error}`);
  }
}

testFixedIngestion().catch(console.error);
