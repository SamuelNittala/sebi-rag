/**
 * Debug script to identify which chunk causes NaN errors in Ollama
 */

import { parsePDF } from "../apps/ingestion/src/parsers/pdf-parser";
import { extractTables } from "../apps/ingestion/src/parsers/table-parser";
import { semanticChunk } from "../apps/ingestion/src/chunkers/semantic-chunker";
import { embedText } from "../apps/ingestion/src/embedding/embedder";

const pdfPath = process.argv[2] || "./data/test-pdfs/1726806037885.pdf";

console.log(`Debugging PDF: ${pdfPath}\n`);

async function debugChunks() {
  try {
    // Parse PDF
    console.log("1. Parsing PDF...");
    const parsed = await parsePDF(pdfPath);
    console.log(`   ✓ Extracted ${parsed.pages.length} pages\n`);

    // Extract tables
    console.log("2. Extracting tables...");
    const tables = await extractTables(pdfPath);
    console.log(`   ✓ Extracted ${tables.length} tables\n`);

    // Chunk document
    console.log("3. Chunking document...");
    const chunks = semanticChunk(parsed, tables);
    console.log(`   ✓ Created ${chunks.chunks.length} chunks\n`);

    // Test embed each chunk individually
    console.log("4. Testing embedding for each chunk...\n");

    const ollamaUrl = "http://localhost:11434";
    let successCount = 0;
    let failedChunks: Array<{ index: number; text: string; error: string }> = [];

    for (let i = 0; i < chunks.chunks.length; i++) {
      const chunk = chunks.chunks[i];

      try {
        // Show progress
        if (i % 10 === 0) {
          process.stdout.write(`   Testing chunk ${i + 1}/${chunks.chunks.length}...\r`);
        }

        // Try to embed
        await embedText(chunk.text, { baseUrl: ollamaUrl });
        successCount++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if it's the NaN error
        if (errorMsg.includes("NaN")) {
          console.log(`\n\n❌ FOUND PROBLEMATIC CHUNK #${i + 1}:`);
          console.log("─".repeat(80));
          console.log(`Chunk Index: ${chunk.chunkIndex}`);
          console.log(`Page Numbers: ${chunk.pageNumbers.join(", ")}`);
          console.log(`Text Length: ${chunk.text.length} characters`);
          console.log(`Token Estimate: ${chunk.tokenCount} tokens`);
          console.log("\nChunk Text (first 500 chars):");
          console.log("─".repeat(80));
          console.log(chunk.text.substring(0, 500));
          console.log("─".repeat(80));
          console.log("\nChunk Text (last 500 chars):");
          console.log("─".repeat(80));
          console.log(chunk.text.substring(Math.max(0, chunk.text.length - 500)));
          console.log("─".repeat(80));

          // Show special characters
          const specialChars = new Set<string>();
          for (const char of chunk.text) {
            const code = char.charCodeAt(0);
            // Non-printable or special Unicode
            if (code < 32 || code > 126) {
              specialChars.add(`${char} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`);
            }
          }

          if (specialChars.size > 0) {
            console.log("\nSpecial Characters Found:");
            console.log(Array.from(specialChars).slice(0, 20).join(", "));
            if (specialChars.size > 20) {
              console.log(`... and ${specialChars.size - 20} more`);
            }
          }

          console.log("\nError:", errorMsg);
          console.log("─".repeat(80));

          failedChunks.push({
            index: i + 1,
            text: chunk.text,
            error: errorMsg,
          });

          // Continue to find all problematic chunks
        } else {
          // Different error
          console.log(`\n⚠️  Chunk ${i + 1} failed with different error: ${errorMsg}`);
        }
      }
    }

    console.log(`\n\n5. Results:`);
    console.log(`   ✓ Successfully embedded: ${successCount}/${chunks.chunks.length}`);
    console.log(`   ✗ Failed with NaN error: ${failedChunks.length}`);

    if (failedChunks.length > 0) {
      console.log(`\n   Problematic chunk indices: ${failedChunks.map(c => c.index).join(", ")}`);
    }

  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

debugChunks();
