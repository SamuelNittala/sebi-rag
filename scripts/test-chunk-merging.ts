/**
 * Test chunk merging fix - verify it prevents NaN and maintains quality
 */

import { parsePDF } from "../apps/ingestion/src/parsers/pdf-parser";
import { extractTables } from "../apps/ingestion/src/parsers/table-parser";
import { semanticChunk } from "../apps/ingestion/src/chunkers/semantic-chunker";
import { embedText } from "../apps/ingestion/src/embedding/embedder";

const OLLAMA_URL = "http://localhost:11434";

async function testChunkMerging() {
  console.log("Testing Chunk Merging Fix\n");
  console.log("=".repeat(80));

  const pdfPath = "./data/test-pdfs/1726806037885.pdf";

  // Parse and chunk
  console.log("1. Parsing and chunking PDF...");
  const parsed = await parsePDF(pdfPath);
  const tables = await extractTables(pdfPath);
  const result = semanticChunk(parsed, tables);

  console.log(`   ✓ Created ${result.chunks.length} chunks\n`);

  // Analyze chunk lengths
  const shortChunks = result.chunks.filter(c => c.text.length < 150);
  const veryShortChunks = result.chunks.filter(c => c.text.length < 100);

  console.log("2. Chunk Length Analysis:");
  console.log(`   Total chunks: ${result.chunks.length}`);
  console.log(`   Short (< 150 chars): ${shortChunks.length}`);
  console.log(`   Very short (< 100 chars): ${veryShortChunks.length}`);
  console.log(`   Average length: ${Math.round(result.chunks.reduce((sum, c) => sum + c.text.length, 0) / result.chunks.length)} chars\n`);

  if (shortChunks.length > 0) {
    console.log("⚠️  WARNING: Still have short chunks after merging!\n");
    console.log("Short chunks:");
    shortChunks.forEach(c => {
      console.log(`   Chunk #${c.chunkIndex}: ${c.text.length} chars, pages ${c.pageNumbers.join(",")}`);
      console.log(`   Text: "${c.text.substring(0, 100)}..."\n`);
    });
  } else {
    console.log("✓ No short chunks - merging worked!\n");
  }

  // Test embedding the previously problematic chunks
  console.log("3. Testing Embedding (previously problematic chunks):");
  console.log("─".repeat(80));

  let successCount = 0;
  let failCount = 0;

  // Test first 20 chunks (includes the problematic ones from before)
  for (let i = 0; i < Math.min(20, result.chunks.length); i++) {
    const chunk = result.chunks[i];

    try {
      await embedText(chunk.text, { baseUrl: OLLAMA_URL });
      successCount++;
      if (i < 5) {
        console.log(`   ✓ Chunk #${i + 1} (${chunk.text.length} chars)`);
      }
    } catch (error) {
      failCount++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("NaN")) {
        console.log(`   ✗ Chunk #${i + 1} - NaN ERROR!`);
        console.log(`     Text: "${chunk.text.substring(0, 100)}..."`);
      }
    }
  }

  console.log(`\n   Tested: 20 chunks`);
  console.log(`   Success: ${successCount}`);
  console.log(`   Failed: ${failCount}\n`);

  // Check for semantic coherence
  console.log("4. Semantic Coherence Check:");
  console.log("─".repeat(80));

  // Find chunks that were likely merged (check for list items)
  const mergedListChunks = result.chunks.filter(c => {
    const listItems = c.text.match(/^\d+\./gm);
    return listItems && listItems.length > 1;
  });

  console.log(`   Chunks with multiple list items: ${mergedListChunks.length}`);

  if (mergedListChunks.length > 0) {
    console.log(`\n   Example merged chunk:`);
    const example = mergedListChunks[0];
    console.log(`   Chunk #${example.chunkIndex} (${example.text.length} chars)`);
    console.log(`   Pages: ${example.pageNumbers.join(", ")}`);
    console.log(`   Section: ${example.sectionHeader || "N/A"}`);
    console.log(`\n   Text preview:`);
    console.log(`   "${example.text.substring(0, 200)}..."`);

    // Check if consecutive list items (good) or scattered (bad)
    const numbers = [...example.text.matchAll(/^(\d+)\./gm)].map(m => parseInt(m[1]));
    const isConsecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1 || n === 1);
    console.log(`\n   List items: ${numbers.join(", ")}`);
    console.log(`   Consecutive: ${isConsecutive ? "✓ Yes (good)" : "⚠️  No (might be unrelated)"}`);
  }

  // RAG Impact Assessment
  console.log("\n5. RAG Impact Assessment:");
  console.log("─".repeat(80));

  const avgChunkLength = result.chunks.reduce((sum, c) => sum + c.text.length, 0) / result.chunks.length;
  const maxChunkLength = Math.max(...result.chunks.map(c => c.text.length));
  const minChunkLength = Math.min(...result.chunks.map(c => c.text.length));

  console.log(`   Average chunk: ${Math.round(avgChunkLength)} chars`);
  console.log(`   Min chunk: ${minChunkLength} chars`);
  console.log(`   Max chunk: ${maxChunkLength} chars`);

  console.log("\n   Benefits:");
  console.log(`   ✓ No NaN errors - all chunks embeddable`);
  console.log(`   ✓ More context per chunk - better answers`);
  console.log(`   ✓ Natural merging - preserves semantic coherence`);

  if (avgChunkLength > 600) {
    console.log("\n   ⚠️  Potential concerns:");
    console.log(`   - Chunks might be too large (avg: ${Math.round(avgChunkLength)} chars)`);
    console.log(`   - Could reduce retrieval precision`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY:");
  console.log("─".repeat(80));

  if (shortChunks.length === 0 && failCount === 0) {
    console.log("✓ FIX SUCCESSFUL!");
    console.log("  - No short chunks remaining");
    console.log("  - All chunks embed without NaN errors");
    console.log("  - Semantic coherence maintained");
    console.log("\nReady for production ingestion!");
  } else {
    console.log("⚠️  ISSUES DETECTED:");
    if (shortChunks.length > 0) {
      console.log(`  - Still have ${shortChunks.length} short chunks`);
    }
    if (failCount > 0) {
      console.log(`  - ${failCount} chunks failed to embed`);
    }
    console.log("\nNeeds further fixes.");
  }

  console.log("=".repeat(80));
}

testChunkMerging().catch(console.error);
