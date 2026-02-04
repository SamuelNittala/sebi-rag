/**
 * Re-ingest the 13 PDFs that failed with NaN errors
 */

import { ingestDocument } from "../apps/ingestion/src/orchestrator/ingest";
import { db, documents, eq } from "@mf-rag/db";
import { VectorClient } from "@mf-rag/vector";

const FAILED_PDFS = [
  "./data/sebi-pdfs/Motilal_Oswal_Mutual_Fund/Motilal Oswal Small Cap Fund.pdf",
  "./data/sebi-pdfs/Unifi_Mutual_Fund/Unifi Liquid Fund.pdf",
  "./data/sebi-pdfs/Shriram_Mutual_Fund/Shriram ELSS Tax Saver Fund.pdf",
  "./data/sebi-pdfs/quant_Mutual_Fund/quant Quantamental Fund.pdf",
  "./data/sebi-pdfs/JM_Financial_Mutual_Fund/JM Small Cap Fund.pdf",
  "./data/sebi-pdfs/PGIM_India_Mutual_Fund/PGIM India Equity Savings Fund.pdf",
  "./data/sebi-pdfs/DynaSIF/DynaSIF Equity Long - Short Fund.pdf",
  "./data/sebi-pdfs/360_ONE_Mutual_Fund/360 ONE Dynamic Bond Fund.pdf",
  "./data/sebi-pdfs/Bandhan_Mutual_Fund/Bandhan BSE India Sector Leaders Index Fund.pdf",
  "./data/sebi-pdfs/Nippon_India_Mutual_Fund/Nippon India Liquid Fund.pdf",
  "./data/sebi-pdfs/LIC_Mutual_Fund/LIC MF S & P BSE Sensex ETF.pdf",
  "./data/sebi-pdfs/HDFC_Mutual_Fund/HDFC Focused 30 Fund.pdf",
  "./data/sebi-pdfs/Invesco/Invesco India - Invesco Global Equity Income Fund of Fund.pdf",
];

async function reingestFailedPdfs() {
  console.log("Re-ingesting 13 failed PDFs with NaN fix...\n");

  // Step 1: Delete failed documents from database
  console.log("Cleaning up failed document records...");

  const vector = new VectorClient();
  await vector.initCollection();

  let deletedCount = 0;

  for (const pdfPath of FAILED_PDFS) {
    const filename = pdfPath.split("/").pop()!;

    // Find document by filename
    const docs = await db
      .select()
      .from(documents)
      .where(eq(documents.filename, filename));

    for (const doc of docs) {
      // Delete chunks from database
      await vector.deleteByDocumentId(doc.id);

      // Delete document from database
      await db.delete(documents).where(eq(documents.id, doc.id));
      deletedCount++;
    }
  }

  console.log(`  Deleted ${deletedCount} failed document records\n`);

  // Step 2: Re-ingest PDFs
  console.log("=" .repeat(80));
  console.log();

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < FAILED_PDFS.length; i++) {
    const pdfPath = FAILED_PDFS[i];
    const fileName = pdfPath.split("/").pop()!;
    const amcName = pdfPath.split("/").slice(-2, -1)[0];

    console.log(`[${i + 1}/${FAILED_PDFS.length}] ${amcName}`);
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
        console.log(`  ✓ Success: ${result.chunkCount} chunks`);
      } else if (result.status === "skipped") {
        console.log(`  ⊘ Skipped: already processed`);
      } else {
        failCount++;
        console.log(`  ✗ Failed: ${result.error}`);
      }
    } catch (error) {
      failCount++;
      console.log(`  ✗ Error: ${error instanceof Error ? error.message : error}`);
    }

    console.log();
  }

  console.log("=" .repeat(80));
  console.log("Re-ingestion Summary");
  console.log("=" .repeat(80));
  console.log(`Total processed: ${FAILED_PDFS.length}`);
  console.log(`Successful:      ${successCount}`);
  console.log(`Failed:          ${failCount}`);
  console.log("=" .repeat(80));
}

reingestFailedPdfs().catch(console.error);
