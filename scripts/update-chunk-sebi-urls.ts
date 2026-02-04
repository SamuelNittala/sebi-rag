/**
 * Update chunk records with SEBI URLs
 *
 * Fetches all chunks from the database and updates them with SEBI URLs
 * by looking up fund data from PostgreSQL.
 */

import { db, chunks, funds, eq } from "@mf-rag/db";
import { VectorClient } from "@mf-rag/vector";
import { count } from "drizzle-orm";

function constructSebiUrl(sebiSchemeId: string): string {
  return `https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doGetFundDetails=yes&mfdId=${sebiSchemeId}`;
}

async function updateChunkSebiUrls() {
  console.log("Connecting to database...\n");

  const vector = new VectorClient();
  await vector.initCollection();

  // Get total chunk count
  const totalResult = await db.select({ count: count() }).from(chunks);
  const totalChunks = totalResult[0].count;
  console.log(`Total chunks: ${totalChunks}`);

  // Get all chunks that need SEBI URL updates
  console.log("Fetching chunks needing SEBI URL updates...");

  let chunksUpdated = 0;
  let chunksWithNoMatch = 0;

  // Process in batches
  const BATCH_SIZE = 100;
  let offset = 0;

  while (true) {
    const chunkBatch = await db
      .select({
        id: chunks.id,
        fundName: chunks.fundName,
        sebiUrl: chunks.sebiUrl,
      })
      .from(chunks)
      .limit(BATCH_SIZE)
      .offset(offset);

    if (chunkBatch.length === 0) {
      break;
    }

    for (const chunk of chunkBatch) {
      if (!chunk.fundName) {
        continue;
      }

      // Look up fund by name
      const fund = await db
        .select()
        .from(funds)
        .where(eq(funds.name, chunk.fundName))
        .limit(1);

      if (fund.length === 0 || !fund[0].sebiSchemeId) {
        chunksWithNoMatch++;
        continue;
      }

      const sebiSchemeId = fund[0].sebiSchemeId;
      const sebiUrl = constructSebiUrl(sebiSchemeId);

      // Update the chunk with SEBI data
      await db
        .update(chunks)
        .set({
          sebiSchemeId: sebiSchemeId,
          sebiUrl: sebiUrl,
        })
        .where(eq(chunks.id, chunk.id));

      chunksUpdated++;

      if (chunksUpdated % 50 === 0) {
        console.log(`  Updated ${chunksUpdated} chunks...`);
      }
    }

    offset += BATCH_SIZE;
  }

  console.log(`\nUpdate complete!`);
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`Updated with SEBI URLs: ${chunksUpdated}`);
  console.log(`No matching fund: ${chunksWithNoMatch}`);
}

updateChunkSebiUrls().catch((error) => {
  console.error("Update failed:", error);
  process.exit(1);
});
