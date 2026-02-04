/**
 * Test downloading one PDF with the fixed downloader
 */

import { downloadPdf } from "../apps/scraper/src/downloader";
import type { DownloadTask } from "../apps/scraper/src/types";

async function testDownload() {
  // Test with Capitalmind Flexi Cap Fund
  const testTask: DownloadTask = {
    schemeId: "16669",
    url: "https://www.sebi.gov.in/web/?file=https://www.sebi.gov.in/sebi_data/mutualfundfile/jan-2026/1752137099636.pdf",
    destPath: "./data/test-download.pdf",
  };

  console.log("Testing PDF download...");
  console.log("URL:", testTask.url);
  console.log();

  const result = await downloadPdf(testTask);

  console.log("Result:", result);

  if (result.success) {
    console.log("\nVerifying downloaded file...");
    const file = Bun.file(testTask.destPath);
    const header = await file.slice(0, 5).text();

    console.log("File size:", result.size, "bytes");
    console.log("PDF header:", header);
    console.log("Valid PDF:", header.startsWith("%PDF-") ? "✓ YES" : "✗ NO");
  }
}

testDownload().catch(console.error);
