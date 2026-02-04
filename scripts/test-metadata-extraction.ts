/**
 * Test metadata extraction on test PDFs
 */

import { parsePDF } from "../apps/ingestion/src/parsers/pdf-parser";
import { extractMetadata } from "../apps/ingestion/src/metadata/extractor";

async function testMetadataExtraction() {
  console.log("Testing Metadata Extraction\n");
  console.log("=".repeat(80));

  const testFiles = [
    "./data/test-pdfs/1749011323267.pdf",
    "./data/test-pdfs/1726806037885.pdf",
    "./data/test-pdfs/1752137099636.pdf",
  ];

  for (const filePath of testFiles) {
    const filename = filePath.split("/").pop()!;
    console.log(`\nFile: ${filename}`);
    console.log("─".repeat(80));

    try {
      // Parse PDF
      const parsed = await parsePDF(filePath);

      // Get first 3 pages for metadata extraction
      const firstPageText = parsed.pages.slice(0, 3).map(p => p.text).join("\n");

      // Extract metadata
      const metadata = extractMetadata({
        filename,
        firstPageText,
      });

      // Display results
      console.log(`Fund Name:        ${metadata.fundName || "❌ NOT EXTRACTED"}`);
      console.log(`AMC Name:         ${metadata.amcName || "❌ NOT EXTRACTED"}`);
      console.log(`Doc Type:         ${metadata.docType}`);
      console.log(`Scheme Type:      ${metadata.schemeType || "N/A"}`);
      console.log(`Scheme Category:  ${metadata.schemeCategory || "N/A"}`);
      console.log(`ISIN (Growth):    ${metadata.isinGrowth || "N/A"}`);
      console.log(`ISIN (Dividend):  ${metadata.isinDividend || "N/A"}`);
      console.log(`Document Date:    ${metadata.documentDate?.toISOString().split("T")[0] || "N/A"}`);

      // Validation
      const issues: string[] = [];
      if (!metadata.fundName) issues.push("Missing fund name");
      if (!metadata.amcName) issues.push("Missing AMC name");
      if (!metadata.schemeType) issues.push("Missing scheme type");
      if (!metadata.schemeCategory) issues.push("Missing scheme category");

      if (issues.length > 0) {
        console.log(`\n⚠️  Issues: ${issues.join(", ")}`);
      } else {
        console.log(`\n✓ All metadata extracted successfully`);
      }

    } catch (error) {
      console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
    }

    console.log("─".repeat(80));
  }

  console.log("\n" + "=".repeat(80));
  console.log("Summary:");
  console.log("─".repeat(80));
  console.log("If fund names and AMC names are extracted correctly,");
  console.log("we can proceed to re-ingest PDFs with proper metadata.");
  console.log("=".repeat(80));
}

testMetadataExtraction().catch(console.error);
