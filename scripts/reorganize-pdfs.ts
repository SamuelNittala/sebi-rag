/**
 * Reorganize PDFs from SID folders to proper AMC folders
 */

import { readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = "./data";
const SEBI_PDFS_DIR = join(DATA_DIR, "sebi-pdfs");
const STATE_FILE = join(DATA_DIR, "scrape-state.json");

interface Scheme {
  sebiId: string;
  name: string;
  amcId: string;
  amcName: string;
  pdfUrl: string | null;
  status: string;
}

interface AMC {
  sebiId: string;
  name: string;
}

interface ScrapeState {
  phase: string;
  amcs: AMC[];
  schemes: Scheme[];
}

function sanitizeFolderName(name: string): string {
  return name
    .replace(/\s+/g, "_")
    .replace(/[()]/g, "")
    .replace(/[^\w\s-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

async function reorganizePDFs() {
  console.log("Loading scrape state...");
  const stateContent = await Bun.file(STATE_FILE).text();
  const state: ScrapeState = JSON.parse(stateContent);

  console.log(`Found ${state.amcs.length} AMCs and ${state.schemes.length} schemes\n`);

  // Build SEBI Fund ID -> AMC name mapping from amcs list
  const fundIdToAmc = new Map<string, string>();
  for (const amc of state.amcs) {
    fundIdToAmc.set(amc.sebiId, amc.name);
  }

  // Build scheme name -> AMC name mapping using sebiFundId
  const schemeToAmc = new Map<string, string>();
  for (const scheme of state.schemes) {
    const amcName = fundIdToAmc.get(scheme.sebiFundId || scheme.amcId);
    if (amcName) {
      schemeToAmc.set(scheme.name, amcName);
    }
  }

  console.log("Scanning existing PDF directories...");
  const oldDirs = readdirSync(SEBI_PDFS_DIR);

  let movedCount = 0;
  let errorCount = 0;
  const errors: string[] = [];

  for (const oldDir of oldDirs) {
    const oldDirPath = join(SEBI_PDFS_DIR, oldDir);

    // Skip if not a directory or not a SID folder
    if (!existsSync(oldDirPath) || !oldDir.startsWith("SID")) {
      continue;
    }

    console.log(`\nProcessing folder: ${oldDir}`);
    const files = readdirSync(oldDirPath);

    for (const file of files) {
      if (!file.endsWith(".pdf")) continue;

      // Extract scheme name (remove .pdf extension)
      const schemeName = file.replace(/\.pdf$/, "");

      // Look up AMC name
      const amcName = schemeToAmc.get(schemeName);

      if (!amcName) {
        errors.push(`No AMC found for scheme: ${schemeName}`);
        errorCount++;
        continue;
      }

      // Create AMC folder
      const sanitizedAmcName = sanitizeFolderName(amcName);
      const newAmcDir = join(SEBI_PDFS_DIR, sanitizedAmcName);

      if (!existsSync(newAmcDir)) {
        mkdirSync(newAmcDir, { recursive: true });
      }

      // Move PDF
      const oldPath = join(oldDirPath, file);
      const newPath = join(newAmcDir, file);

      try {
        renameSync(oldPath, newPath);
        movedCount++;
        if (movedCount % 100 === 0) {
          console.log(`  Moved ${movedCount} PDFs...`);
        }
      } catch (err) {
        errors.push(`Failed to move ${file}: ${err}`);
        errorCount++;
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(`Reorganization complete!`);
  console.log(`  Moved: ${movedCount} PDFs`);
  console.log(`  Errors: ${errorCount}`);

  if (errors.length > 0 && errors.length <= 10) {
    console.log("\nErrors:");
    errors.forEach(err => console.log(`  - ${err}`));
  }

  console.log("\nCleaning up empty SID folders...");
  let deletedCount = 0;
  for (const oldDir of oldDirs) {
    if (!oldDir.startsWith("SID")) continue;

    const oldDirPath = join(SEBI_PDFS_DIR, oldDir);
    if (!existsSync(oldDirPath)) continue;

    const remaining = readdirSync(oldDirPath);
    if (remaining.length === 0) {
      try {
        Bun.spawnSync(["rmdir", oldDirPath]);
        deletedCount++;
      } catch {
        // Ignore errors
      }
    }
  }

  console.log(`Deleted ${deletedCount} empty folders`);
  console.log("=".repeat(80));
}

reorganizePDFs().catch(console.error);
