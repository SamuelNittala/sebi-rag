/**
 * Clean up orphaned chunks from old ingestions (timestamp-based filenames)
 *
 * These chunks have document_filename like "1749011323267.pdf" and weren't
 * deleted during re-ingestion because the filename didn't match.
 */

import { db, chunks } from "@mf-rag/db";
import { like, count } from "drizzle-orm";
import { VectorClient } from "@mf-rag/vector";

const vector = new VectorClient();
await vector.initCollection();

console.log("Scanning for orphaned chunks with timestamp filenames...\n");

// Find chunks with timestamp-based filenames (all digits before .pdf)
// Use a regex-like pattern to find numeric filenames
const orphanedChunks = await db
  .select({ id: chunks.id, documentFilename: chunks.documentFilename })
  .from(chunks)
  .where(like(chunks.documentFilename, "%.pdf"));

// Filter to only timestamp filenames (all digits)
const timestampChunks = orphanedChunks.filter((chunk) => {
  const filename = chunk.documentFilename;
  return filename && /^\d+\.pdf$/.test(filename);
});

console.log(`Found ${timestampChunks.length} orphaned chunks to delete\n`);

if (timestampChunks.length === 0) {
  console.log("✓ No orphaned chunks found!");
  process.exit(0);
}

// Show sample of orphaned chunks
console.log("Sample orphaned chunk details:");
if (timestampChunks.length > 0) {
  const sampleChunk = await db
    .select({
      documentFilename: chunks.documentFilename,
      fundName: chunks.fundName,
      amcName: chunks.amcName,
    })
    .from(chunks)
    .where(like(chunks.documentFilename, timestampChunks[0].documentFilename))
    .limit(1);

  if (sampleChunk.length > 0) {
    console.log(`  ${sampleChunk[0].documentFilename}:`);
    console.log(`    Fund: ${sampleChunk[0].fundName}`);
    console.log(`    AMC: ${sampleChunk[0].amcName}`);
  }
}

console.log("\nDeleting orphaned chunks...");

// Delete in batches of 100
const chunkIds = timestampChunks.map((c) => c.id);
for (let i = 0; i < chunkIds.length; i += 100) {
  const batch = chunkIds.slice(i, i + 100);

  for (const id of batch) {
    await db.delete(chunks).where(like(chunks.id, id));
  }

  const progress = Math.min(i + 100, chunkIds.length);
  console.log(`  Deleted ${progress}/${chunkIds.length} chunks`);
}

console.log(`\n✓ Successfully deleted ${timestampChunks.length} orphaned chunks!`);

// Verify final state
const finalCount = await db.select({ count: count() }).from(chunks);
console.log(`\nFinal chunk count: ${finalCount[0].count}`);
console.log(`Expected: ${13544} (53 PDFs × ~255 chunks average)`);
