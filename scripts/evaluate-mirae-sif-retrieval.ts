import { Embedder } from "../packages/core/src/index.ts";
import { VectorClient } from "../packages/vector/src/index.ts";
import { createTenantAccessScope } from "../packages/types/src/index.ts";

import { searchHybridDocuments } from "../apps/mcp-server/src/hybrid-search.ts";
import { resolveRetrievalScope } from "../apps/mcp-server/src/retrieval-scope.ts";

interface RegressionCase {
  id: string;
  query: string;
  expectedFactType: string;
  maxRank: number;
  textPattern?: RegExp;
  allowTextFallback?: boolean;
}

const cases: RegressionCase[] = [
  {
    id: "strategy_manager",
    query: "Who is the fund manager for Platinum SIF?",
    expectedFactType: "fund_manager",
    maxRank: 1,
    textPattern: /Gaurik\s+Shah/i,
  },
  {
    id: "investment_objective",
    query: "What is the investment objective for Platinum SIF?",
    expectedFactType: "investment_objective",
    maxRank: 3,
  },
  {
    id: "benchmark",
    query: "What is the benchmark for Platinum SIF?",
    expectedFactType: "benchmark",
    maxRank: 3,
  },
  {
    id: "minimum_investment",
    query: "What is the minimum investment for Platinum SIF?",
    expectedFactType: "minimum_investment",
    maxRank: 3,
  },
  {
    id: "exit_load",
    query: "What is the exit load for Platinum SIF?",
    expectedFactType: "exit_load",
    maxRank: 3,
  },
  {
    id: "investment_approach",
    query: "What is the investment approach of Platinum SIF?",
    expectedFactType: "investment_approach",
    maxRank: 3,
  },
  {
    id: "expenses",
    query: "What are the expenses and TER for Platinum SIF?",
    expectedFactType: "expenses",
    maxRank: 3,
    textPattern: /\bBER\b|percentage limit of daily net assets|charges?\/expenses?/i,
    allowTextFallback: true,
  },
  {
    id: "redemption",
    query: "How can units in Platinum SIF be redeemed?",
    expectedFactType: "redemption",
    maxRank: 3,
    textPattern: /units? will be redeemed|withdrawals? will commence|applicable NAV/i,
    allowTextFallback: true,
  },
  {
    id: "risk",
    query: "What are the risk factors for Platinum SIF?",
    expectedFactType: "risk",
    maxRank: 3,
  },
  {
    id: "investment_strategy",
    query: "What is the investment strategy of Platinum SIF?",
    expectedFactType: "investment_strategy",
    maxRank: 3,
  },
];

const embedder = new Embedder({
  baseUrl: process.env.OLLAMA_BASE_URL,
  model: process.env.EMBEDDING_MODEL ?? "bge-m3",
});
const vectorClient = new VectorClient();
const accessScope = createTenantAccessScope(process.env.AMC_SCOPE ?? "");
const selectedCaseId = process.env.MIRAE_RETRIEVAL_CASE;
const selectedCases = selectedCaseId
  ? cases.filter((item) => item.id === selectedCaseId)
  : cases;
if (selectedCases.length === 0) {
  throw new Error(`Unknown MIRAE_RETRIEVAL_CASE: ${selectedCaseId}`);
}
const vectors = await embedder.embedBatch(selectedCases.map((item) => item.query));
const evaluations = [];

for (const [index, regression] of selectedCases.entries()) {
  const scope = resolveRetrievalScope({ question: regression.query });
  const debugCandidates = process.env.MIRAE_RETRIEVAL_DEBUG === "true"
    ? await Promise.all([
        vectorClient.searchSimilar(vectors[index]!, {
          accessScope,
          limit: 10,
          filters: scope.pdfFilters,
          scoreThreshold: 0.5,
        }),
        vectorClient.searchLexical(regression.query, {
          accessScope,
          limit: 10,
          filters: scope.pdfFilters,
        }),
        vectorClient.searchHtmlSimilar(vectors[index]!, {
          accessScope,
          limit: 10,
          filters: scope.htmlFilters,
          scoreThreshold: 0.5,
        }),
        vectorClient.searchHtmlLexical(regression.query, {
          accessScope,
          limit: 10,
          filters: scope.htmlFilters,
        }),
      ])
    : null;
  const startedAt = performance.now();
  const response = await searchHybridDocuments(
    vectorClient,
    regression.query,
    vectors[index]!,
    {
      accessScope,
      limit: 10,
      scoreThreshold: 0.5,
      candidateLimit: Number(process.env.RETRIEVAL_CANDIDATE_LIMIT ?? 40),
      rrfK: Number(process.env.RETRIEVAL_RRF_K ?? 60),
      ...scope,
    },
  );
  const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const expectedRankIndex = response.results.findIndex((result) => {
    const factMatches = result.metadata?.factType === regression.expectedFactType;
    const textMatches = !regression.textPattern || regression.textPattern.test(result.text);
    return regression.allowTextFallback
      ? factMatches || textMatches
      : factMatches && textMatches;
  });
  const expectedRank = expectedRankIndex === -1 ? null : expectedRankIndex + 1;
  const passed = expectedRank !== null && expectedRank <= regression.maxRank;
  evaluations.push({
    id: regression.id,
    query: regression.query,
    passed,
    expectedFactType: regression.expectedFactType,
    expectedRank,
    maxRank: regression.maxRank,
    latencyMs,
    candidateCounts: response.retrieval,
    ...(debugCandidates && {
      debugCandidates: {
        pdfDense: debugCandidates[0].map((result) => ({
          score: result.score,
          factType: result.payload.retrieval_metadata?.factType ?? null,
          section: result.payload.section_header,
          excerpt: result.payload.text.replace(/\s+/g, " ").slice(0, 140),
        })),
        pdfLexical: debugCandidates[1].map((result) => ({
          score: result.score,
          factType: result.payload.retrieval_metadata?.factType ?? null,
          section: result.payload.section_header,
          excerpt: result.payload.text.replace(/\s+/g, " ").slice(0, 140),
        })),
        htmlDense: debugCandidates[2].map((result) => ({
          score: result.score,
          factType: result.payload.retrieval_metadata?.factType ?? null,
          section: result.payload.section_heading,
          excerpt: result.payload.text.replace(/\s+/g, " ").slice(0, 140),
        })),
        htmlLexical: debugCandidates[3].map((result) => ({
          score: result.score,
          factType: result.payload.retrieval_metadata?.factType ?? null,
          section: result.payload.section_heading,
          excerpt: result.payload.text.replace(/\s+/g, " ").slice(0, 140),
        })),
      },
    }),
    topResults: response.results.slice(0, 3).map((result, resultIndex) => ({
      rank: resultIndex + 1,
      sourceType: result.sourceType,
      factType: result.metadata?.factType ?? null,
      documentScope: result.metadata?.documentScope ?? null,
      strategyId: result.metadata?.strategyId ?? null,
      sectionHeader: result.sectionHeader,
      document: result.documentFilename ?? result.documentTitle ?? null,
      excerpt: result.text.replace(/\s+/g, " ").slice(0, 220),
      trace: result.retrievalTrace,
    })),
  });
}

const passed = evaluations.filter((item) => item.passed).length;
const reciprocalRankSum = evaluations.reduce(
  (sum, item) => sum + (item.expectedRank ? 1 / item.expectedRank : 0),
  0,
);
const latencies = evaluations.map((item) => item.latencyMs).sort((a, b) => a - b);
const p95Index = Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1);
const report = {
  summary: {
    cases: evaluations.length,
    passed,
    failed: evaluations.length - passed,
    recallAt3: passed / evaluations.length,
    meanReciprocalRank: reciprocalRankSum / evaluations.length,
    averageSearchLatencyMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p95SearchLatencyMs: latencies[p95Index],
  },
  evaluations,
};

console.log(JSON.stringify(report, null, 2));
if (passed !== evaluations.length) process.exitCode = 1;
