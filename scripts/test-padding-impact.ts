/**
 * Test different padding strategies for short text embeddings
 */

const OLLAMA_URL = "http://localhost:11434";
const MODEL = "bge-m3";

async function embed(text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: text }),
    });

    if (!response.ok) {
      const error = await response.text();
      return null;
    }

    const data = await response.json();
    return data.embeddings[0];
  } catch (error) {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function testPaddingStrategies() {
  console.log("Testing Padding Strategies for BGE-M3\n");
  console.log("=".repeat(80));

  // Problematic short text (from our debug session)
  const shortText = "1. No principal amount is exchanged. A notional principal amount is agreed upon for interest calculation purposes.";

  // Related query that should find this chunk
  const query = "What happens to the principal amount in derivatives?";

  console.log("\nOriginal Short Text:");
  console.log(`"${shortText}"`);
  console.log(`Length: ${shortText.length} chars\n`);

  console.log("Query:");
  console.log(`"${query}"\n`);

  // Strategy 1: Original (causes NaN)
  console.log("1. ORIGINAL (No padding) - Expected to fail");
  const emb1 = await embed(shortText);
  console.log(`   Result: ${emb1 ? "✓ Success" : "✗ Failed (NaN)"}\n`);

  // Strategy 2: Whitespace padding
  const MIN_LENGTH = 150;
  const whitespaceText = shortText + " ".repeat(MIN_LENGTH - shortText.length);
  console.log("2. WHITESPACE PADDING");
  console.log(`   Text: "${shortText}${" ".repeat(20)}..." (${whitespaceText.length} chars)`);
  const emb2 = await embed(whitespaceText);
  console.log(`   Result: ${emb2 ? "✓ Success" : "✗ Failed (NaN)"}\n`);

  // Strategy 3: Whitespace + context marker (current approach)
  const paddedText = shortText + " ".repeat(MIN_LENGTH - shortText.length - 28) + "[context: financial document]";
  console.log("3. WHITESPACE + CONTEXT MARKER");
  console.log(`   Text: "${shortText}...${paddedText.slice(-30)}" (${paddedText.length} chars)`);
  const emb3 = await embed(paddedText);
  console.log(`   Result: ${emb3 ? "✓ Success" : "✗ Failed (NaN)"}\n`);

  // Strategy 4: Document prefix (alternative)
  const prefixedText = `Document excerpt: ${shortText}`;
  console.log("4. DOCUMENT PREFIX");
  console.log(`   Text: "Document excerpt: ${shortText.substring(0, 50)}..."`);
  const emb4 = await embed(prefixedText);
  console.log(`   Result: ${emb4 ? "✓ Success" : "✗ Failed (NaN)"}\n`);

  // Strategy 5: Longer normal text (baseline)
  const longText = "This is a comprehensive document about financial derivatives. " + shortText + " These instruments are commonly used in hedging strategies.";
  console.log("5. MERGED WITH CONTEXT (baseline - ideal)");
  console.log(`   Text: "${longText.substring(0, 60)}..."`);
  const emb5 = await embed(longText);
  console.log(`   Result: ${emb5 ? "✓ Success" : "✗ Failed (NaN)"}\n`);

  // Embed the query
  console.log("=".repeat(80));
  console.log("\nEmbedding query...");
  const queryEmb = await embed(query);
  console.log(`Query embedding: ${queryEmb ? "✓ Success" : "✗ Failed"}\n`);

  if (!queryEmb) {
    console.log("Cannot test similarity - query embedding failed");
    return;
  }

  // Compare similarities
  console.log("=".repeat(80));
  console.log("\nSIMILARITY TO QUERY (higher = better retrieval):");
  console.log("─".repeat(80));

  if (emb2 && queryEmb) {
    const sim2 = cosineSimilarity(emb2, queryEmb);
    console.log(`Whitespace padding:        ${sim2.toFixed(4)}`);
  }

  if (emb3 && queryEmb) {
    const sim3 = cosineSimilarity(emb3, queryEmb);
    console.log(`Whitespace + marker:       ${sim3.toFixed(4)}`);
  }

  if (emb4 && queryEmb) {
    const sim4 = cosineSimilarity(emb4, queryEmb);
    console.log(`Document prefix:           ${sim4.toFixed(4)}`);
  }

  if (emb5 && queryEmb) {
    const sim5 = cosineSimilarity(emb5, queryEmb);
    console.log(`Merged with context:       ${sim5.toFixed(4)} ← BASELINE`);
  }

  console.log("─".repeat(80));

  // Analysis
  console.log("\n=".repeat(80));
  console.log("ANALYSIS:");
  console.log("─".repeat(80));

  if (emb2 && emb5) {
    const diff2 = Math.abs(cosineSimilarity(emb2, queryEmb!) - cosineSimilarity(emb5, queryEmb!));
    console.log(`Whitespace impact: ${diff2 > 0.05 ? "⚠️  SIGNIFICANT" : "✓ Minimal"} (diff: ${diff2.toFixed(4)})`);
  }

  if (emb3 && emb5) {
    const diff3 = Math.abs(cosineSimilarity(emb3, queryEmb!) - cosineSimilarity(emb5, queryEmb!));
    console.log(`Marker impact:     ${diff3 > 0.05 ? "⚠️  SIGNIFICANT" : "✓ Minimal"} (diff: ${diff3.toFixed(4)})`);
  }

  if (emb4 && emb5) {
    const diff4 = Math.abs(cosineSimilarity(emb4, queryEmb!) - cosineSimilarity(emb5, queryEmb!));
    console.log(`Prefix impact:     ${diff4 > 0.05 ? "⚠️  SIGNIFICANT" : "✓ Minimal"} (diff: ${diff4.toFixed(4)})`);
  }

  console.log("\n=".repeat(80));
  console.log("RECOMMENDATION:");
  console.log("─".repeat(80));

  let bestStrategy = "";
  let bestSim = -1;

  if (emb2) {
    const sim = cosineSimilarity(emb2, queryEmb!);
    if (sim > bestSim) {
      bestSim = sim;
      bestStrategy = "Whitespace padding";
    }
  }

  if (emb3) {
    const sim = cosineSimilarity(emb3, queryEmb!);
    if (sim > bestSim) {
      bestSim = sim;
      bestStrategy = "Whitespace + context marker";
    }
  }

  if (emb4) {
    const sim = cosineSimilarity(emb4, queryEmb!);
    if (sim > bestSim) {
      bestSim = sim;
      bestStrategy = "Document prefix";
    }
  }

  console.log(`Best strategy (closest to baseline): ${bestStrategy}`);
  console.log(`\nIdeal solution: Merge short chunks during chunking phase`);
  console.log(`This avoids the NaN bug AND maintains semantic accuracy.`);
  console.log("=".repeat(80));
}

testPaddingStrategies();
