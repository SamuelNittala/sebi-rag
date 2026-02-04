/**
 * Test semantic search on ingested PDFs
 */

import { embedText } from "../apps/ingestion/src/embedding/embedder";
import { VectorClient } from "@mf-rag/vector";

const OLLAMA_URL = "http://localhost:11434";

async function testSemanticSearch() {
  console.log("Testing Semantic Search\n");
  console.log("=".repeat(80));

  // Test queries
  const queries = [
    "What are the expense ratios and fees?",
    "Who manages the fund?",
    "What are the derivative investment restrictions?",
    "How can I redeem my investment?",
    "What are the risk factors?",
  ];

  const vector = new VectorClient();

  for (const query of queries) {
    console.log(`\nQuery: "${query}"`);
    console.log("─".repeat(80));

    try {
      // 1. Embed the query
      console.log("Embedding query...");
      const queryVector = await embedText(query, { baseUrl: OLLAMA_URL });
      console.log(`✓ Generated embedding (${queryVector.length} dimensions)`);

      // 2. Search pgvector
      console.log("Searching vector database...");
      const results = await vector.searchSimilar(queryVector, {
        limit: 3,
        scoreThreshold: 0.3,
      });

      console.log(`✓ Found ${results.length} results\n`);

      // 3. Display results
      if (results.length === 0) {
        console.log("No results found above threshold (0.3)");
      } else {
        results.forEach((result, idx) => {
          console.log(`Result ${idx + 1}:`);
          console.log(`  Score: ${result.score.toFixed(4)}`);
          console.log(`  Fund: ${result.payload.fund_name || "N/A"}`);
          console.log(`  AMC: ${result.payload.amc_name || "N/A"}`);
          console.log(`  Type: ${result.payload.scheme_type || "N/A"} - ${result.payload.doc_type || "N/A"}`);
          console.log(`  Document: ${result.payload.document_filename}`);
          console.log(`  Pages: ${result.payload.page_numbers.join(", ")}`);
          console.log(`  Section: ${result.payload.section_header || "N/A"}`);

          // Show SEBI URL if available
          if (result.payload.sebi_url) {
            console.log(`  SEBI URL: ${result.payload.sebi_url}`);
          } else {
            console.log(`  SEBI URL: ⚠️  Not available`);
          }

          console.log(`  Text (first 200 chars):`);
          const preview = result.payload.text.substring(0, 200).replace(/\n/g, " ");
          console.log(`    "${preview}${result.payload.text.length > 200 ? "..." : ""}"`);
          console.log();
        });
      }
    } catch (error) {
      console.error(`✗ Error: ${error instanceof Error ? error.message : error}`);
    }

    console.log("─".repeat(80));
  }

  // Collection stats
  console.log("\n" + "=".repeat(80));
  console.log("Collection Statistics:");
  console.log("─".repeat(80));

  const info = await vector.getCollectionInfo();
  console.log(`Total vectors: ${info.vectors_count}`);
  console.log(`Collection status: ${info.status}`);
  console.log("=".repeat(80));
}

testSemanticSearch().catch(console.error);
