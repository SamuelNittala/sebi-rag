/**
 * Merge duplicate fund records
 *
 * Strategy:
 * 1. Find funds with NULL SEBI IDs (created during ingestion)
 * 2. Find matching funds with valid SEBI IDs (from scraper import)
 * 3. Update the NULL records with SEBI IDs from matching records
 * 4. Delete the duplicate imported records
 */

import { db, funds, documents, documentFunds, eq, and } from "@mf-rag/db";
import { isNull } from "drizzle-orm";

function normalizeFundName(name: string): string {
  return name
    .toLowerCase()
    .replace(/mutual fund/gi, "")
    .replace(/trustee company/gi, "")
    .replace(/the amc/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function mergeDuplicateFunds() {
  console.log("Finding funds created during ingestion (NULL SEBI IDs)...\n");

  // Get all funds without SEBI IDs (created during ingestion)
  const fundsWithoutSebiId = await db
    .select()
    .from(funds)
    .where(isNull(funds.sebiSchemeId));

  console.log(`Found ${fundsWithoutSebiId.length} funds without SEBI IDs\n`);

  // Get all funds with SEBI IDs (from scraper import)
  const fundsWithSebiId = await db
    .select()
    .from(funds)
    .where(and(
      eq(funds.sebiSchemeId, funds.sebiSchemeId), // Not null check
    ));

  console.log(`Found ${fundsWithSebiId.length} funds with SEBI IDs\n`);

  // Build lookup map by normalized name
  const sebiIdMap = new Map<string, typeof fundsWithSebiId[0]>();
  for (const fund of fundsWithSebiId) {
    const normalized = normalizeFundName(fund.name);
    sebiIdMap.set(normalized, fund);
  }

  console.log("Merging duplicates...\n");

  let updated = 0;
  let notFound = 0;
  const notFoundList: string[] = [];

  for (const fund of fundsWithoutSebiId) {
    const normalized = normalizeFundName(fund.name);
    const match = sebiIdMap.get(normalized);

    if (match) {
      // Move all document links from the NULL record to the SEBI record
      await db
        .update(documentFunds)
        .set({ fundId: match.id })
        .where(eq(documentFunds.fundId, fund.id));

      // Delete the duplicate NULL record
      await db
        .delete(funds)
        .where(eq(funds.id, fund.id));

      updated++;
      console.log(`✓ ${fund.name}`);
      console.log(`  → Merged into fund with SEBI ID: ${match.sebiSchemeId}`);
    } else {
      notFound++;
      notFoundList.push(fund.name);
    }
  }

  console.log(`\nResults:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Not found: ${notFound}`);

  if (notFoundList.length > 0 && notFoundList.length <= 10) {
    console.log(`\nFunds without matches:`);
    for (const name of notFoundList) {
      console.log(`  - ${name}`);
    }
  } else if (notFoundList.length > 10) {
    console.log(`\nFirst 10 funds without matches:`);
    for (const name of notFoundList.slice(0, 10)) {
      console.log(`  - ${name}`);
    }
    console.log(`  ... and ${notFoundList.length - 10} more`);
  }

  // Now check if we can delete the duplicate records from import
  console.log(`\nCleaning up duplicate imported records...`);

  // Find funds with SEBI IDs that have no linked documents
  const fundsToDelete = await db
    .select({
      id: funds.id,
      name: funds.name,
    })
    .from(funds)
    .leftJoin(documentFunds, eq(documentFunds.fundId, funds.id))
    .where(
      and(
        eq(funds.sebiSchemeId, funds.sebiSchemeId), // Has SEBI ID
        isNull(documentFunds.documentId) // No linked documents
      )
    );

  console.log(`Found ${fundsToDelete.length} duplicate imported records (no documents linked)`);

  // Don't delete for now - just report
  console.log("\nSkipping deletion to preserve data integrity.");
  console.log("You can manually delete these later if needed.");

  console.log("\nMerge complete!");
}

mergeDuplicateFunds().catch((error) => {
  console.error("Merge failed:", error);
  process.exit(1);
});
