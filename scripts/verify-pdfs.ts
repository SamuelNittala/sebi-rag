/**
 * Verify downloaded PDFs are valid
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";

const SEBI_PDFS_DIR = "./data/sebi-pdfs";

interface VerificationResult {
  totalPdfs: number;
  validPdfs: number;
  invalidPdfs: number;
  emptyPdfs: number;
  corruptedPdfs: number;
  tooSmall: number;
  errors: string[];
}

async function verifyPDFs() {
  console.log("Verifying downloaded PDFs...\n");

  const result: VerificationResult = {
    totalPdfs: 0,
    validPdfs: 0,
    invalidPdfs: 0,
    emptyPdfs: 0,
    corruptedPdfs: 0,
    tooSmall: 0,
    errors: [],
  };

  const amcDirs = readdirSync(SEBI_PDFS_DIR);

  for (const amcDir of amcDirs) {
    const amcPath = join(SEBI_PDFS_DIR, amcDir);

    try {
      const stat = statSync(amcPath);
      if (!stat.isDirectory()) continue;

      const files = readdirSync(amcPath);

      for (const file of files) {
        if (!file.endsWith(".pdf")) continue;

        result.totalPdfs++;
        const filePath = join(amcPath, file);

        try {
          const fileSize = statSync(filePath).size;

          // Check if empty
          if (fileSize === 0) {
            result.emptyPdfs++;
            result.errors.push(`Empty file: ${amcDir}/${file}`);
            continue;
          }

          // Check if suspiciously small (< 10 KB is likely an error page)
          if (fileSize < 10 * 1024) {
            result.tooSmall++;
            result.errors.push(`Too small (${fileSize} bytes): ${amcDir}/${file}`);
            continue;
          }

          // Check PDF header
          const fileHandle = Bun.file(filePath);
          const header = await fileHandle.slice(0, 5).text();

          if (!header.startsWith("%PDF-")) {
            result.invalidPdfs++;
            result.errors.push(`Invalid PDF header: ${amcDir}/${file}`);
            continue;
          }

          // Valid PDF
          result.validPdfs++;

        } catch (err) {
          result.corruptedPdfs++;
          result.errors.push(`Error reading ${amcDir}/${file}: ${err}`);
        }
      }
    } catch (err) {
      console.error(`Error processing directory ${amcDir}: ${err}`);
    }

    // Progress indicator
    if (result.totalPdfs % 500 === 0 && result.totalPdfs > 0) {
      console.log(`Checked ${result.totalPdfs} PDFs...`);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("PDF Verification Results");
  console.log("=".repeat(80));
  console.log(`Total PDFs:       ${result.totalPdfs}`);
  console.log(`Valid PDFs:       ${result.validPdfs} (${((result.validPdfs / result.totalPdfs) * 100).toFixed(1)}%)`);
  console.log(`Empty files:      ${result.emptyPdfs}`);
  console.log(`Too small:        ${result.tooSmall}`);
  console.log(`Invalid header:   ${result.invalidPdfs}`);
  console.log(`Corrupted:        ${result.corruptedPdfs}`);
  console.log("=".repeat(80));

  if (result.errors.length > 0 && result.errors.length <= 20) {
    console.log("\nIssues found:");
    result.errors.forEach(err => console.log(`  - ${err}`));
  } else if (result.errors.length > 20) {
    console.log(`\n${result.errors.length} issues found. First 20:`);
    result.errors.slice(0, 20).forEach(err => console.log(`  - ${err}`));
  }

  // Size distribution
  console.log("\nChecking size distribution of valid PDFs...");
  const sizes: number[] = [];

  for (const amcDir of amcDirs) {
    const amcPath = join(SEBI_PDFS_DIR, amcDir);
    if (!statSync(amcPath).isDirectory()) continue;

    const files = readdirSync(amcPath);
    for (const file of files) {
      if (!file.endsWith(".pdf")) continue;
      const fileSize = statSync(join(amcPath, file)).size;
      if (fileSize >= 10 * 1024) {
        sizes.push(fileSize);
      }
    }
  }

  if (sizes.length > 0) {
    sizes.sort((a, b) => a - b);
    const min = sizes[0];
    const max = sizes[sizes.length - 1];
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    const median = sizes[Math.floor(sizes.length / 2)];

    console.log(`  Min size:    ${(min / 1024).toFixed(0)} KB`);
    console.log(`  Max size:    ${(max / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  Average:     ${(avg / 1024).toFixed(0)} KB`);
    console.log(`  Median:      ${(median / 1024).toFixed(0)} KB`);
  }

  return result;
}

verifyPDFs().catch(console.error);
