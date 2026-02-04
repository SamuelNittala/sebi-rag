/**
 * Import SEBI metadata from scraper state into PostgreSQL
 *
 * Reads data/scrape-state.json and populates:
 * - amcs table (AMC-level data with SEBI fund IDs)
 * - funds table (scheme-level data with SEBI scheme IDs)
 */

import { db, amcs, funds } from "@mf-rag/db";
import { eq } from "@mf-rag/db";

interface ScraperState {
  phase: string;
  amcs: Array<{
    sebiId: string;
    name: string;
  }>;
  schemes: Array<{
    sebiSchemeId: string;
    sebiFundId: string;
    name: string;
    amcName: string;
    pdfUrl?: string;
  }>;
}

async function importSebiMetadata() {
  console.log("Loading scraper state...\n");

  const stateFile = Bun.file("./data/scrape-state.json");
  if (!await stateFile.exists()) {
    console.error("Error: scrape-state.json not found!");
    console.error("Run the scraper first: bun run apps/scraper/src/index.ts scrape");
    process.exit(1);
  }

  const state: ScraperState = await stateFile.json();

  console.log(`Found ${state.amcs.length} AMCs and ${state.schemes.length} schemes\n`);

  // First, import AMCs
  console.log("Importing AMCs...");
  let amcCount = 0;
  let amcUpdated = 0;

  for (const amc of state.amcs) {
    // Check if AMC already exists
    const existing = await db
      .select()
      .from(amcs)
      .where(eq(amcs.sebiId, amc.sebiId))
      .limit(1);

    if (existing.length === 0) {
      // Insert new AMC
      await db.insert(amcs).values({
        name: amc.name,
        sebiId: amc.sebiId,
      });
      amcCount++;
    } else {
      // Update existing AMC name in case it changed
      await db
        .update(amcs)
        .set({ name: amc.name })
        .where(eq(amcs.sebiId, amc.sebiId));
      amcUpdated++;
    }
  }

  console.log(`  Created: ${amcCount}, Updated: ${amcUpdated}\n`);

  // Build AMC ID lookup map (SEBI ID -> DB ID)
  const amcMap = new Map<string, string>();
  const allAmcs = await db.select().from(amcs);
  for (const amc of allAmcs) {
    if (amc.sebiId) {
      amcMap.set(amc.sebiId, amc.id);
    }
  }

  // Then, import schemes as funds
  console.log("Importing schemes...");
  let fundCount = 0;
  let fundUpdated = 0;

  for (const scheme of state.schemes) {
    const amcId = amcMap.get(scheme.sebiFundId);

    // Check if fund already exists by SEBI scheme ID
    const existing = await db
      .select()
      .from(funds)
      .where(eq(funds.sebiSchemeId, scheme.sebiSchemeId))
      .limit(1);

    if (existing.length === 0) {
      // Insert new fund
      await db.insert(funds).values({
        name: scheme.name,
        amcName: scheme.amcName,
        sebiSchemeId: scheme.sebiSchemeId,
        sebiFundId: scheme.sebiFundId,
        amcId: amcId,
      });
      fundCount++;
    } else {
      // Update existing fund in case data changed
      await db
        .update(funds)
        .set({
          name: scheme.name,
          amcName: scheme.amcName,
          sebiFundId: scheme.sebiFundId,
          amcId: amcId,
        })
        .where(eq(funds.sebiSchemeId, scheme.sebiSchemeId));
      fundUpdated++;
    }
  }

  console.log(`  Created: ${fundCount}, Updated: ${fundUpdated}\n`);

  console.log("Import complete!");
  console.log("\nDatabase now contains:");
  console.log(`  AMCs: ${amcCount + amcUpdated}`);
  console.log(`  Schemes: ${fundCount + fundUpdated}`);
}

importSebiMetadata().catch((error) => {
  console.error("Import failed:", error);
  process.exit(1);
});
