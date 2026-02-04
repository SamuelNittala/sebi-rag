import { db, getFundByName } from "@mf-rag/db";

const fundsToCheck = [
  "Canara Robeco Infrastructure",
  "Canara Robeco Blue Chip Equity Fund",
  "Capitalmind Flexi Cap Fund",
];

console.log("Checking SEBI scheme IDs for problematic funds...\n");
console.log("=".repeat(80));

for (const fundName of fundsToCheck) {
  console.log(`\n${fundName}:`);

  const fund = await getFundByName(db, fundName);

  if (fund) {
    console.log(`  ✓ Found in database`);
    console.log(`    AMC Name: ${fund.amcName || "(null)"}`);
    console.log(`    SEBI Scheme ID: ${fund.sebiSchemeId || "(null)"}`);
    console.log(`    SEBI Fund ID: ${fund.sebiFundId || "(null)"}`);

    if (!fund.sebiSchemeId) {
      console.log(`    ⚠️  Missing SEBI Scheme ID - database metadata won't be used!`);
    }
  } else {
    console.log(`  ✗ Not found in database`);
  }
}

console.log("\n" + "=".repeat(80));
console.log("\nRoot cause analysis:");
console.log("If sebiSchemeId is null, lookupSebiMetadata() returns null,");
console.log("causing the ingestion to fall back to path/content extraction.");
console.log("This explains why some chunks have inconsistent AMC names.");
