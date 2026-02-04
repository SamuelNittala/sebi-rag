import { db, chunks, getFundByName } from "@mf-rag/db";
import { VectorClient } from "@mf-rag/vector";

const vector = new VectorClient();
await vector.initCollection();

// Get all unique AMC names and their associated funds
const amcToFunds = new Map<string, Set<string>>();

console.log("Scanning all chunks for AMC-fund relationships...\n");

// Query all unique amc_name/fund_name combinations
const amcFundCombos = await db
  .selectDistinct({
    amcName: chunks.amcName,
    fundName: chunks.fundName,
  })
  .from(chunks);

for (const combo of amcFundCombos) {
  if (combo.amcName && combo.fundName) {
    if (!amcToFunds.has(combo.amcName)) {
      amcToFunds.set(combo.amcName, new Set());
    }
    amcToFunds.get(combo.amcName)!.add(combo.fundName);
  }
}

console.log("Checking for AMCs with potential variations...\n");
console.log("=".repeat(80));

// Check Canara Robeco variations
console.log("\n🔍 Canara Robeco Variations:");
const canaraVariations = Array.from(amcToFunds.keys()).filter(amc =>
  amc.toLowerCase().includes("canara") && amc.toLowerCase().includes("robeco")
);

for (const amcName of canaraVariations) {
  const funds = Array.from(amcToFunds.get(amcName)!);
  console.log(`\n  ${amcName}:`);
  for (const fund of funds) {
    console.log(`    - ${fund}`);

    // Check database for this fund
    const dbFund = await getFundByName(db, fund);

    if (dbFund) {
      console.log(`      DB AMC: ${dbFund.amcName || "(null)"}`);
    } else {
      console.log(`      DB: Not found (using path extraction)`);
    }
  }
}

// Check Capitalmind variations
console.log("\n\n🔍 Capitalmind Variations:");
const capitalmindVariations = Array.from(amcToFunds.keys()).filter(amc =>
  amc.toLowerCase().includes("capitalmind")
);

for (const amcName of capitalmindVariations) {
  const funds = Array.from(amcToFunds.get(amcName)!);
  console.log(`\n  ${amcName}:`);
  for (const fund of funds) {
    console.log(`    - ${fund}`);

    // Check database for this fund
    const dbFund = await getFundByName(db, fund);

    if (dbFund) {
      console.log(`      DB AMC: ${dbFund.amcName || "(null)"}`);
    } else {
      console.log(`      DB: Not found (using path extraction)`);
    }
  }
}

console.log("\n" + "=".repeat(80));
