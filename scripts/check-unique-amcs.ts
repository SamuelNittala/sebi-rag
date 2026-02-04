import { db, chunks } from "@mf-rag/db";
import { VectorClient } from "@mf-rag/vector";

const vector = new VectorClient();
await vector.initCollection();

console.log("Scanning all chunks for unique AMC names...\n");

// Get all unique AMC names using SQL DISTINCT
const uniqueAmcs = await db
  .selectDistinct({ amcName: chunks.amcName })
  .from(chunks)
  .orderBy(chunks.amcName);

console.log(`Total unique AMC names: ${uniqueAmcs.length}\n`);
console.log("All AMC names:");
for (const row of uniqueAmcs) {
  console.log(`  - ${row.amcName}`);
}
