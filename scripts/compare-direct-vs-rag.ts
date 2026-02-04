#!/usr/bin/env bun
/**
 * Compare direct search vs RAGPipeline output for A/B testing.
 *
 * Tests:
 * 1. search_mutual_funds_direct - Embedder + VectorClient (no LLM)
 * 2. query_mutual_funds - Full RAGPipeline (with LLM)
 *
 * Usage:
 *   bun scripts/compare-direct-vs-rag.ts "What is the expense ratio of HDFC Focused 30 Fund?"
 */

import { RAGPipeline } from "@mf-rag/core";
import { Embedder } from "@mf-rag/core";
import { VectorClient, type SearchFilters } from "@mf-rag/vector";

const query = process.argv[2] || "What is the expense ratio?";

console.log("=".repeat(80));
console.log("QUERY:", query);
console.log("=".repeat(80));

// Initialize clients
const pipeline = new RAGPipeline({
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.LLM_MODEL ?? "qwen2.5:7b",
  },
});

const embedder = new Embedder({
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
});

const vectorClient = new VectorClient();

// ============================================================================
// Test 1: Direct Search (no LLM)
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("TEST 1: DIRECT SEARCH (Embedder + VectorClient, no LLM)");
console.log("=".repeat(80));

const directStart = Date.now();

try {
  // 1. Embed the query
  const queryVector = await embedder.embed(query);
  const embedTime = Date.now() - directStart;

  // 2. Search pgvector
  const searchStart = Date.now();
  const results = await vectorClient.searchSimilar(queryVector, {
    limit: 10,
    scoreThreshold: 0.5,
  });
  const searchTime = Date.now() - searchStart;

  const directTotalTime = Date.now() - directStart;

  // 3. Build response
  const chunks = results.map((r, i) => ({
    rank: i + 1,
    score: parseFloat(r.score.toFixed(3)),
    text: r.payload.text,
    fundName: r.payload.fund_name,
    docType: r.payload.doc_type,
    pageNumbers: r.payload.page_numbers,
    sectionHeader: r.payload.section_header,
  }));

  // Deduplicate citations
  const citationMap = new Map<string, {
    fundName: string;
    docType: string;
    pageNumbers: number[];
    sebiUrl: string;
  }>();

  for (const r of results) {
    const key = `${r.payload.fund_name}|${r.payload.doc_type}`;
    const existing = citationMap.get(key);
    if (existing) {
      const pages = new Set([...existing.pageNumbers, ...r.payload.page_numbers]);
      existing.pageNumbers = Array.from(pages).sort((a, b) => a - b);
    } else {
      citationMap.set(key, {
        fundName: r.payload.fund_name,
        docType: r.payload.doc_type,
        pageNumbers: [...r.payload.page_numbers],
        sebiUrl: r.payload.sebi_url,
      });
    }
  }

  const citations = Array.from(citationMap.values());

  console.log("\n📊 TIMING:");
  console.log(`   Embedding: ${embedTime}ms`);
  console.log(`   Search: ${searchTime}ms`);
  console.log(`   TOTAL: ${directTotalTime}ms`);

  console.log("\n📋 CHUNKS RETRIEVED:", chunks.length);

  console.log("\n📄 TOP 3 CHUNKS:");
  for (const chunk of chunks.slice(0, 3)) {
    console.log(`\n   [${chunk.rank}] Score: ${chunk.score} | ${chunk.fundName} | ${chunk.docType}`);
    console.log(`   Pages: ${chunk.pageNumbers.join(", ")}`);
    if (chunk.sectionHeader) {
      console.log(`   Section: ${chunk.sectionHeader}`);
    }
    console.log(`   Text: ${chunk.text.slice(0, 300)}...`);
  }

  console.log("\n📚 CITATIONS:");
  for (const citation of citations) {
    console.log(`   - ${citation.fundName} (${citation.docType}) - Pages: ${citation.pageNumbers.join(", ")}`);
    console.log(`     URL: ${citation.sebiUrl}`);
  }

  // Store for comparison
  (globalThis as any).directResult = {
    chunks,
    citations,
    timing: { embedTime, searchTime, total: directTotalTime },
  };

} catch (error) {
  console.error("Direct search error:", error);
}

// ============================================================================
// Test 2: RAGPipeline (with LLM)
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("TEST 2: RAGPipeline (Full pipeline with LLM generation)");
console.log("=".repeat(80));

const ragStart = Date.now();

try {
  const response = await pipeline.query({
    query,
    limit: 10,
  });

  const ragTotalTime = Date.now() - ragStart;

  console.log("\n📊 TIMING:");
  console.log(`   TOTAL: ${response.metadata.queryTimeMs}ms (reported)`);
  console.log(`   TOTAL: ${ragTotalTime}ms (measured)`);

  console.log("\n📋 CHUNKS USED:", response.metadata.chunksUsed);
  console.log("📋 CHUNKS RETRIEVED:", response.metadata.chunksRetrieved);

  if (response.metadata.detectedFund) {
    console.log("\n🔍 DETECTED FUND:", JSON.stringify(response.metadata.detectedFund, null, 2));
  }

  console.log("\n💬 GENERATED ANSWER:");
  console.log("-".repeat(40));
  console.log(response.answer);
  console.log("-".repeat(40));

  console.log("\n📚 CITATIONS:");
  for (const citation of response.citations) {
    console.log(`   [${citation.index}] ${citation.fundName} (${citation.docType}) - Pages: ${citation.pageNumbers.join(", ")}`);
    console.log(`       Score: ${citation.relevanceScore?.toFixed(3)}`);
    console.log(`       URL: ${citation.sebiUrl}`);
    console.log(`       Snippet: ${citation.textSnippet?.slice(0, 100)}...`);
  }

  // Store for comparison
  (globalThis as any).ragResult = {
    answer: response.answer,
    citations: response.citations,
    timing: { total: ragTotalTime, reported: response.metadata.queryTimeMs },
    metadata: response.metadata,
  };

} catch (error) {
  console.error("RAGPipeline error:", error);
}

// ============================================================================
// Comparison Summary
// ============================================================================
console.log("\n" + "=".repeat(80));
console.log("COMPARISON SUMMARY");
console.log("=".repeat(80));

const direct = (globalThis as any).directResult;
const rag = (globalThis as any).ragResult;

if (direct && rag) {
  console.log("\n⏱️  LATENCY:");
  console.log(`   Direct Search: ${direct.timing.total}ms`);
  console.log(`   RAGPipeline:   ${rag.timing.total}ms`);
  console.log(`   Speedup:       ${(rag.timing.total / direct.timing.total).toFixed(1)}x faster with direct`);

  console.log("\n📊 CHUNKS:");
  console.log(`   Direct: ${direct.chunks.length} chunks retrieved`);
  console.log(`   RAG:    ${rag.metadata.chunksRetrieved} retrieved, ${rag.metadata.chunksUsed} used`);

  console.log("\n📚 CITATIONS:");
  console.log(`   Direct: ${direct.citations.length} unique fund/doc combinations`);
  console.log(`   RAG:    ${rag.citations.length} citations`);

  // Check if same funds are found
  const directFunds = new Set(direct.citations.map((c: any) => c.fundName));
  const ragFunds = new Set(rag.citations.map((c: any) => c.fundName));
  const overlap = [...directFunds].filter(f => ragFunds.has(f));

  console.log("\n🎯 FUND OVERLAP:");
  console.log(`   Direct found: ${[...directFunds].join(", ")}`);
  console.log(`   RAG found:    ${[...ragFunds].join(", ")}`);
  console.log(`   Overlap:      ${overlap.length}/${Math.max(directFunds.size, ragFunds.size)} funds match`);

  console.log("\n💡 RECOMMENDATION:");
  if (direct.timing.total < rag.timing.total / 2) {
    console.log("   ✅ Direct search is significantly faster");
    console.log("   ✅ Claude can synthesize from raw chunks");
    console.log("   ✅ No per-query LLM cost");
    console.log("   → RECOMMENDED: Use search_mutual_funds_direct for MCP");
  } else {
    console.log("   ⚠️  Direct search not much faster than RAGPipeline");
    console.log("   → Consider: Keep RAGPipeline if answer quality is important");
  }
}

console.log("\n" + "=".repeat(80));
