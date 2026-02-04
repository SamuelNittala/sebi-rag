/**
 * Semantic search CLI for testing queries against the MF RAG system
 *
 * Usage: bun semantic-search-ui.ts "your query here"
 */

import { VectorClient } from "@mf-rag/vector";
import { embedText } from "../apps/ingestion/src/embedding/embedder";

const query = process.argv[2];

if (!query) {
  console.error("Usage: bun semantic-search-ui.ts \"your query\"");
  console.error("\nExample: bun semantic-search-ui.ts \"tax saving funds with low expense ratio\"");
  process.exit(1);
}

console.log(`🔍 Searching for: "${query}"\n`);

// Generate query embedding
console.log("Generating embedding...");
const queryVector = await embedText(query, {
  baseUrl: "http://localhost:11434",
});

console.log("Searching vector database...\n");

// Search pgvector
const vector = new VectorClient();
const results = await vector.searchSimilar(queryVector, {
  limit: 10,
  scoreThreshold: 0.0,
});

console.log("=" .repeat(80));
console.log(`Found ${results.length} results\n`);

for (let i = 0; i < results.length; i++) {
  const result = results[i];

  console.log(`${i + 1}. Score: ${result.score.toFixed(4)}`);
  console.log(`   Fund: ${result.payload.fund_name || "N/A"}`);
  console.log(`   AMC: ${result.payload.amc_name || "N/A"}`);
  console.log(`   Type: ${result.payload.scheme_type || "N/A"} - ${result.payload.scheme_category || "N/A"}`);
  console.log(`   Document: ${result.payload.document_filename}`);
  console.log(`   Pages: ${result.payload.page_numbers?.join(", ") || "N/A"}`);
  console.log(`   Section: ${result.payload.section_header || "N/A"}`);

  if (result.payload.sebi_url) {
    console.log(`   SEBI: ${result.payload.sebi_url}`);
  } else {
    console.log(`   SEBI: ⚠️  Not available`);
  }

  // Show a snippet of the content
  if (result.payload.text) {
    const content = result.payload.text.substring(0, 200).replace(/\n/g, " ").trim();
    console.log(`   Text: "${content}..."`);
  }

  console.log();
}

console.log("=" .repeat(80));
