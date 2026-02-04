/**
 * Debug NaN embedding errors
 *
 * Tests embedding one of the failed PDFs to identify which chunks cause NaN
 */

import { parsePDF } from "../apps/ingestion/src/parsers/pdf-parser.ts";
import { extractTables } from "../apps/ingestion/src/parsers/table-parser.ts";
import { semanticChunk, type ChunkInput } from "../apps/ingestion/src/chunkers/semantic-chunker.ts";
import { createEmbedder } from "../apps/ingestion/src/embedding/embedder.ts";

async function debugNanEmbedding() {
  // Test with one of the failed PDFs
  const testPdf = "./data/sebi-pdfs/Motilal_Oswal_Mutual_Fund/Motilal Oswal Small Cap Fund.pdf";

  console.log("Testing PDF:", testPdf);
  console.log();

  // Parse PDF
  console.log("Parsing PDF...");
  const parsedPdf = await parsePDF(testPdf);
  console.log(`  Pages: ${parsedPdf.pageCount}`);

  // Extract tables
  console.log("Extracting tables...");
  const tableResult = await extractTables(testPdf);
  console.log(`  Tables: ${tableResult.tables.length}`);

  // Chunk
  console.log("Chunking...");
  const chunkInput: ChunkInput = {
    pages: parsedPdf.pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
    })),
    tables: tableResult.tables.map((t) => ({
      pageNumber: t.page,
      markdown: t.markdown,
    })),
  };

  const chunkResult = semanticChunk(chunkInput);
  console.log(`  Chunks: ${chunkResult.chunks.length}\n`);

  // Try embedding each chunk individually to find the problematic ones
  const embedder = createEmbedder({
    baseUrl: "http://localhost:11434",
    batchSize: 1,
  });

  console.log("Testing embeddings...\n");

  let nanCount = 0;
  const problematicChunks: Array<{ index: number; length: number; preview: string }> = [];

  for (let i = 0; i < chunkResult.chunks.length; i++) {
    const chunk = chunkResult.chunks[i];

    try {
      const result = await embedder.embed(chunk.text);

      // Check for NaN in the embedding
      const hasNaN = result.some(val => isNaN(val));

      if (hasNaN) {
        nanCount++;
        problematicChunks.push({
          index: i,
          length: chunk.text.length,
          preview: chunk.text.substring(0, 200).replace(/\n/g, " "),
        });
        console.log(`✗ Chunk ${i}: NaN in embedding`);
        console.log(`  Length: ${chunk.text.length}`);
        console.log(`  Preview: ${chunk.text.substring(0, 200).replace(/\n/g, " ")}`);
        console.log();
      } else {
        if ((i + 1) % 50 === 0) {
          console.log(`✓ Processed ${i + 1}/${chunkResult.chunks.length} chunks`);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`✗ Chunk ${i}: Error - ${errorMsg}`);
      console.log(`  Length: ${chunk.text.length}`);
      console.log(`  Preview: ${chunk.text.substring(0, 200).replace(/\n/g, " ")}`);
      console.log();
      problematicChunks.push({
        index: i,
        length: chunk.text.length,
        preview: chunk.text.substring(0, 200).replace(/\n/g, " "),
      });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total chunks: ${chunkResult.chunks.length}`);
  console.log(`NaN embeddings: ${nanCount}`);
  console.log(`Problematic chunks: ${problematicChunks.length}`);

  if (problematicChunks.length > 0) {
    console.log("\nChunk length distribution:");
    const lengths = problematicChunks.map(c => c.length);
    console.log(`  Min: ${Math.min(...lengths)}`);
    console.log(`  Max: ${Math.max(...lengths)}`);
    console.log(`  Avg: ${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)}`);
  }
}

debugNanEmbedding().catch(console.error);
