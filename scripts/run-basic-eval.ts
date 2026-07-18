/**
 * Basic end-to-end eval runner for the Mirae SIF golden set.
 *
 * Per case:
 *   1. Retrieve top candidates — either in-process via the exact MCP server
 *      path (resolveRetrievalScope + searchHybridDocuments), or remotely via
 *      the deployed MCP server's query_mutual_funds tool (--mcp-url) — the
 *      same tool Finley's knowledge path calls; it returns full chunk text.
 *   2. Narrate the query + top-3 chunks through the llama server using the
 *      same prompt Finley uses (SUMMARIZE_SYSTEM_PROMPT + "User query: ...\n\n
 *      Information:\n[1] ..." — copied verbatim from investor-agent
 *      apps/orchestrator/src/agents/slm/narrate/prompts.ts and
 *      slm-pipeline.service.ts summarize()).
 *   3. Score retrieval_hit@3 and answer_correct; record latencies.
 *
 * Output: console summary + docs/eval-runs/<date>[-<label>]-basic-eval.md
 * (plus a .json sibling with full per-case detail for diffing).
 *
 * Usage:
 *   bun run eval:basic [label]
 *   bun run eval:basic post-fix --mcp-url https://<rag-mcp-host> --mcp-api-key $KEY
 *
 * Flags:
 *   --mcp-url <url>       Retrieve via a remote MCP server (streamable HTTP)
 *                         instead of in-process DB access. No local DB needed.
 *   --mcp-api-key <key>   Sent as "Authorization: Bearer <key>" on MCP requests.
 *   --topic <topic>       Pass topic (e.g. "sif") to the MCP tool. Omit to test
 *                         the server's own scope resolution.
 *
 * Env: OLLAMA_BASE_URL / NARRATE_BASE_URL / NARRATE_MODEL / NARRATE_API_KEY
 * override endpoints; DATABASE_URL is required only for in-process retrieval.
 */

// Type-only imports — erased at runtime, so --mcp-url mode never loads
// @mf-rag/db / @mf-rag/vector. Runtime retrieval modules are imported
// dynamically per mode in main().
import type { HtmlSearchFilters, SearchFilters } from "../packages/vector/src/index.ts";

export interface GoldenCase {
  id: string;
  category: "fact" | "descriptive" | "colloquial" | "trap";
  query: string;
  expectPattern: string;
  expectNumbers: string[];
  expectRefusal?: boolean;
  note?: string;
}

/** Uniform candidate shape shared by the in-process and MCP retrieval modes. */
interface Candidate {
  text: string;
  score: number;
  sourceType: string;
  sectionHeader: string | null;
  document: string | null;
}

interface CaseScope {
  searchPdf: boolean;
  searchHtml: boolean;
  rankingProfile: string | null;
  pdfFilters: SearchFilters;
  htmlFilters: HtmlSearchFilters;
}

interface Retriever {
  mode: "in-process" | "mcp";
  retrieve: (testCase: GoldenCase) => Promise<{ candidates: Candidate[]; scope: CaseScope | null }>;
  close: () => Promise<void>;
}

interface CaseResult {
  id: string;
  category: GoldenCase["category"];
  query: string;
  hitAt3: boolean;
  answerCorrect: boolean;
  patternMatched: boolean;
  numbersMatched: boolean;
  inventedNumbers: number[];
  retrievalMs: number;
  narrateMs: number;
  answer: string;
  retrievalError?: string;
  scope: CaseScope | null;
  top5: Array<{
    rank: number;
    score: number;
    sourceType: string;
    sectionHeader: string | null;
    document: string | null;
    excerpt: string;
  }>;
}

interface CliArgs {
  label?: string;
  mcpUrl?: string;
  mcpApiKey?: string;
  topic?: string;
}

// ---------------------------------------------------------------------------
// Config — mirrors apps/mcp-server/src/index.ts
// ---------------------------------------------------------------------------

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const config = {
  embedding: {
    baseUrl: ollamaBaseUrl,
    model: process.env.EMBEDDING_MODEL ?? "bge-m3",
  },
  search: {
    defaultLimit: 10,
    scoreThreshold: 0.5,
    candidateLimit: Number(process.env.RETRIEVAL_CANDIDATE_LIMIT ?? 40),
    rrfK: Number(process.env.RETRIEVAL_RRF_K ?? 60),
  },
  narrate: {
    // llama-server / Ollama OpenAI-compatible endpoint (same shape Finley's
    // SLM_NARRATE_PROVIDER=openai + SLM_NARRATE_BASE_URL=...:/v1 uses).
    baseUrl: process.env.NARRATE_BASE_URL ?? `${ollamaBaseUrl}/v1`,
    model: process.env.NARRATE_MODEL ?? process.env.OLLAMA_LLM_MODEL ?? "qwen2.5:7b",
    apiKey: process.env.NARRATE_API_KEY,
    timeoutMs: Number(process.env.NARRATE_TIMEOUT_MS ?? 120_000),
  },
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--mcp-url" || token === "--mcp-api-key" || token === "--topic") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`Flag ${token} requires a value`);
      }
      if (token === "--mcp-url") args.mcpUrl = value;
      else if (token === "--mcp-api-key") args.mcpApiKey = value;
      else args.topic = value;
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown flag: ${token}`);
    } else if (!args.label) {
      args.label = token;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  if ((args.mcpApiKey || args.topic) && !args.mcpUrl) {
    throw new Error("--mcp-api-key/--topic require --mcp-url");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Retrieval modes
// ---------------------------------------------------------------------------

/** In-process retrieval — the exact path apps/mcp-server/src/index.ts runs. */
async function createInProcessRetriever(): Promise<Retriever> {
  const { Embedder } = await import("../packages/core/src/index.ts");
  const { VectorClient } = await import("../packages/vector/src/index.ts");
  const { searchHybridDocuments } = await import("../apps/mcp-server/src/hybrid-search.ts");
  const { resolveRetrievalScope } = await import("../apps/mcp-server/src/retrieval-scope.ts");

  const embedder = new Embedder({
    baseUrl: config.embedding.baseUrl,
    model: config.embedding.model,
  });
  const vectorClient = new VectorClient();

  return {
    mode: "in-process",
    async retrieve(testCase: GoldenCase) {
      const scope = resolveRetrievalScope({ question: testCase.query });
      const queryVector = await embedder.embed(testCase.query);
      const { results: merged } = await searchHybridDocuments(
        vectorClient,
        testCase.query,
        queryVector,
        {
          limit: config.search.defaultLimit,
          scoreThreshold: config.search.scoreThreshold,
          candidateLimit: config.search.candidateLimit,
          rrfK: config.search.rrfK,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile,
        },
      );
      return {
        candidates: merged.map((item) => ({
          text: item.text,
          score: item.score,
          sourceType: item.source_type,
          sectionHeader: item.sectionHeader,
          document: item.documentFilename ?? item.documentTitle ?? null,
        })),
        scope: {
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile ?? null,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
        },
      };
    },
    async close() {
      // pg pool is torn down by process.exit in the entrypoint
    },
  };
}

/**
 * Remote retrieval via the deployed MCP server (streamable HTTP transport).
 * Calls query_mutual_funds — the same tool Finley's knowledge integration
 * uses (investor-agent slm-pipeline.service.ts query_knowledge path) — which
 * returns FULL chunk text, unlike search_mutual_fund_docs' 300-char excerpts.
 * One session is reused across all cases.
 */
async function createMcpRetriever(
  mcpUrl: string,
  apiKey?: string,
  topic?: string,
): Promise<Retriever> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const url = new URL(mcpUrl);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";

  const transport = new StreamableHTTPClientTransport(
    url,
    apiKey
      ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }
      : undefined,
  );
  const client = new Client({ name: "run-basic-eval", version: "0.1.0" });
  await client.connect(transport);

  return {
    mode: "mcp",
    async retrieve(testCase: GoldenCase) {
      // Same call shape as Finley: { question } (+ optional topic). No limit
      // argument — the server applies its own default (10), matching both
      // Finley's knowledge path and this script's in-process mode.
      const result = (await client.callTool({
        name: "query_mutual_funds",
        arguments: {
          question: testCase.query,
          ...(topic ? { topic } : {}),
        },
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

      const text = result.content?.find((item) => item.type === "text")?.text ?? "";
      if (result.isError) {
        throw new Error(`MCP tool error: ${text.slice(0, 300)}`);
      }

      const payload = JSON.parse(text) as {
        chunks?: Array<{
          score?: number;
          source_type?: string;
          text?: string;
          sectionHeader?: string | null;
          fundName?: string;
          docType?: string;
          documentTitle?: string;
        }>;
      };

      return {
        candidates: (payload.chunks ?? []).map((item) => ({
          text: item.text ?? "",
          score: item.score ?? 0,
          sourceType: item.source_type ?? "unknown",
          sectionHeader: item.sectionHeader ?? null,
          document:
            item.source_type === "scheme_document"
              ? [item.fundName, item.docType].filter(Boolean).join(" — ") || null
              : item.documentTitle ?? null,
        })),
        scope: null, // scope is resolved server-side in MCP mode
      };
    },
    async close() {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Finley narrate prompt — copied verbatim, do not edit here.
// Source: investor-agent/apps/orchestrator/src/agents/slm/narrate/prompts.ts
// ---------------------------------------------------------------------------

const SUMMARIZE_SYSTEM_PROMPT = `You are the Narrate layer of an Indian mutual fund and SIF (Specialized Investment Fund) app. Synthesize the provided information into a clear, concise answer. Match the user's language (English, Hindi, or Hinglish).

Rules:
- Base your answer ONLY on the information provided. Never invent data. If the information is empty or has nothing relevant to the query, briefly say you don't have that detail instead of guessing. (Off-topic queries are already filtered out upstream — do not refuse a query yourself.)
- Use Indian MF and SIF terms as proper nouns — never expand: NAV, AMC, SIP, SWP, STP, IDCW (not "dividend"), ELSS, LTCG, STCG, XIRR, CAGR, AUM, TER, SEBI, RTA.
- Use "units" not "shares", "folio" not "account", "NAV" not "price".
- Use Indian number system: lakh (not lakhs), crore (not crores). Never use K, M, B.
- No markdown headers (##), no tables, no code fences, no emojis, no exclamation marks.
- No disclaimers, no greetings, no sign-offs.
- Never recommend buy/sell/hold — you render information, not advice.`;

// Source: investor-agent/apps/orchestrator/src/agents/slm/guards/knowledge-cap.ts
const DEFAULT_KNOWLEDGE_CHAR_BUDGET = 8000;

function capKnowledgeChunks(
  chunks: string[],
  maxChars: number = DEFAULT_KNOWLEDGE_CHAR_BUDGET,
): string[] {
  if (maxChars <= 0) return [];
  const kept: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used >= maxChars) break;
    const remaining = maxChars - used;
    if (chunk.length <= remaining) {
      kept.push(chunk);
      used += chunk.length;
    } else {
      kept.push(chunk.slice(0, remaining));
      break;
    }
  }
  return kept;
}

// Source: investor-agent slm-pipeline.service.ts — fixed reply when RAG
// returns nothing (the narrate model never sees an evidence-free prompt).
const NO_KNOWLEDGE_RESULTS_ENGLISH =
  "I don't have that detail in the available information.";

/**
 * Build the summarize user message exactly as Finley's summarize() does.
 * The force-English line mirrors SLM_NARRATE_FORCE_ENGLISH.
 */
function buildSummarizeUserContent(userMessage: string, chunks: string[]): string {
  const capped = capKnowledgeChunks(chunks);
  const forceEnglishLine =
    process.env.SLM_NARRATE_FORCE_ENGLISH === "true"
      ? "RESPONSE LANGUAGE: ENGLISH — reply ONLY in English regardless of the query's language.\n\n"
      : "";
  return `${forceEnglishLine}User query: ${userMessage}\n\nInformation:\n${capped.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}`;
}

export async function narrate(userMessage: string, chunks: string[]): Promise<string> {
  const body = {
    model: config.narrate.model,
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
      { role: "user", content: buildSummarizeUserContent(userMessage, chunks) },
    ],
    temperature: 0,
    stream: false,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.narrate.apiKey) headers.Authorization = `Bearer ${config.narrate.apiKey}`;

  const response = await fetch(`${config.narrate.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.narrate.timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Narrate call failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Narrate response missing choices[0].message.content`);
  }
  return content.trim();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * Extract every numeric value mentioned in text, normalizing ₹/Rs prefixes,
 * Indian comma grouping (1,00,000), and lakh/crore notation. Word numbers
 * one–ten are included so "five installments" satisfies expectNumbers: ["5"].
 */
export function extractNumbers(text: string): number[] {
  let t = text.replace(/₹/g, " ").replace(/\brs\.?(?=\s|\d)/gi, " ");
  t = t.replace(/(\d),(?=\d)/g, "$1");
  const nums: number[] = [];
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?)\b/gi, (_, n: string) => {
    nums.push(parseFloat(n) * 1e5);
    return " ";
  });
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:crores?|\bcr\b)/gi, (_, n: string) => {
    nums.push(parseFloat(n) * 1e7);
    return " ";
  });
  for (const match of t.matchAll(/\d+(?:\.\d+)?/g)) {
    nums.push(parseFloat(match[0]));
  }
  for (const match of t.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi)) {
    nums.push(WORD_NUMBERS[match[1]!.toLowerCase()]!);
  }
  return nums;
}

export function normalizeExpectedNumber(entry: string): number {
  const cleaned = entry.replace(/[₹,\s]/g, "").replace(/lakhs?$/i, "");
  const value = parseFloat(cleaned);
  if (/lakhs?$/i.test(entry.replace(/[₹,\s]/g, ""))) return value * 1e5;
  return value;
}

export function scoreCase(testCase: GoldenCase, answer: string, top3Texts: string[]) {
  const pattern = new RegExp(testCase.expectPattern, "is");
  const hitAt3 = top3Texts.some((text) => pattern.test(text));
  const patternMatched = pattern.test(answer);
  const answerNumbers = extractNumbers(answer);

  let numbersMatched = true;
  let inventedNumbers: number[] = [];
  let answerCorrect: boolean;

  if (testCase.category === "trap" && testCase.expectRefusal === true) {
    // Trap: must match the refusal pattern AND contain no invented numbers.
    inventedNumbers = answerNumbers;
    answerCorrect = patternMatched && answerNumbers.length === 0;
  } else if (testCase.category === "fact" && testCase.expectNumbers.length > 0) {
    const expected = testCase.expectNumbers.map(normalizeExpectedNumber);
    numbersMatched = expected.every((value) =>
      answerNumbers.some((found) => Math.abs(found - value) < 1e-6),
    );
    answerCorrect = patternMatched && numbersMatched;
  } else {
    answerCorrect = patternMatched;
  }

  return { hitAt3, patternMatched, numbersMatched, inventedNumbers, answerCorrect };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting
// ---------------------------------------------------------------------------

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * p) - 1);
  return sortedValues[Math.max(0, index)]!;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const goldenSetPath = new URL("../tests/retrieval/sif-golden-set.json", import.meta.url).pathname;
  const goldenSet = (await Bun.file(goldenSetPath).json()) as {
    version: string;
    cases: GoldenCase[];
  };

  const retriever = args.mcpUrl
    ? await createMcpRetriever(args.mcpUrl, args.mcpApiKey, args.topic)
    : await createInProcessRetriever();

  console.log(`Running basic eval: ${goldenSet.cases.length} cases (golden set ${goldenSet.version})`);
  if (retriever.mode === "mcp") {
    console.log(`  retrieval: MCP @ ${args.mcpUrl}${args.topic ? ` (topic=${args.topic})` : ""}`);
  } else {
    console.log(`  retrieval: in-process (embedding ${config.embedding.model} @ ${config.embedding.baseUrl})`);
  }
  console.log(`  narrate:   ${config.narrate.model} @ ${config.narrate.baseUrl}`);

  const results: CaseResult[] = [];

  for (const testCase of goldenSet.cases) {
    const retrievalStart = performance.now();
    let candidates: Candidate[] = [];
    let scope: CaseScope | null = null;
    let retrievalError: string | undefined;
    try {
      const retrieved = await retriever.retrieve(testCase);
      candidates = retrieved.candidates;
      scope = retrieved.scope;
    } catch (error) {
      retrievalError = error instanceof Error ? error.message : String(error);
    }
    const retrievalMs = Math.round(performance.now() - retrievalStart);

    const top3Texts = candidates.slice(0, 3).map((item) => item.text);

    let answer: string;
    let narrateMs = 0;
    let score: ReturnType<typeof scoreCase>;

    if (retrievalError) {
      // Retrieval failed outright — score as a miss, don't fake a refusal pass.
      answer = `(retrieval failed: ${retrievalError})`;
      score = {
        hitAt3: false,
        patternMatched: false,
        numbersMatched: false,
        inventedNumbers: [],
        answerCorrect: false,
      };
    } else {
      if (candidates.length === 0) {
        // Mirror Finley's empty-results short-circuit: fixed reply, no narrate call.
        answer = NO_KNOWLEDGE_RESULTS_ENGLISH;
      } else {
        const narrateStart = performance.now();
        answer = await narrate(testCase.query, top3Texts);
        narrateMs = Math.round(performance.now() - narrateStart);
      }
      score = scoreCase(testCase, answer, top3Texts);
    }

    results.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      hitAt3: score.hitAt3,
      answerCorrect: score.answerCorrect,
      patternMatched: score.patternMatched,
      numbersMatched: score.numbersMatched,
      inventedNumbers: score.inventedNumbers,
      retrievalMs,
      narrateMs,
      answer,
      ...(retrievalError && { retrievalError }),
      scope,
      top5: candidates.slice(0, 5).map((item, index) => ({
        rank: index + 1,
        score: Math.round(item.score * 1000) / 1000,
        sourceType: item.sourceType,
        sectionHeader: item.sectionHeader,
        document: item.document,
        excerpt: item.text.replace(/\s+/g, " ").slice(0, 200),
      })),
    });

    const marker = retrievalError ? " ⚠ retrieval error" : "";
    console.log(
      `  ${testCase.id} [${testCase.category}] hit@3=${score.hitAt3 ? "✅" : "❌"} answer=${score.answerCorrect ? "✅" : "❌"} (retr ${retrievalMs}ms, narr ${narrateMs}ms)${marker}`,
    );
  }

  await retriever.close();

  // --- Aggregates ---

  const categories = ["descriptive", "fact", "colloquial", "trap"] as const;
  const hitCount = results.filter((item) => item.hitAt3).length;
  const correctCount = results.filter((item) => item.answerCorrect).length;
  const errorCount = results.filter((item) => item.retrievalError).length;
  const byCategory = categories.map((category) => {
    const subset = results.filter((item) => item.category === category);
    return {
      category,
      total: subset.length,
      hit: subset.filter((item) => item.hitAt3).length,
      correct: subset.filter((item) => item.answerCorrect).length,
    };
  });

  const retrievalLatencies = results.map((item) => item.retrievalMs).sort((a, b) => a - b);
  const narrateLatencies = results.map((item) => item.narrateMs).sort((a, b) => a - b);
  const totalLatencies = results
    .map((item) => item.retrievalMs + item.narrateMs)
    .sort((a, b) => a - b);

  const summary = {
    cases: results.length,
    hitAt3: hitCount,
    hitAt3Pct: pct(hitCount, results.length),
    answerCorrect: correctCount,
    answerCorrectPct: pct(correctCount, results.length),
    retrievalErrors: errorCount,
    byCategory,
    p95RetrievalMs: percentile(retrievalLatencies, 0.95),
    p95NarrateMs: percentile(narrateLatencies, 0.95),
    p95TotalMs: percentile(totalLatencies, 0.95),
  };

  // --- Console summary ---

  console.log("\n=== Summary ===");
  console.log(`hit@3:          ${summary.hitAt3}/${summary.cases} (${summary.hitAt3Pct})`);
  console.log(`answer_correct: ${summary.answerCorrect}/${summary.cases} (${summary.answerCorrectPct})`);
  if (errorCount > 0) console.log(`retrieval errors: ${errorCount}`);
  for (const row of byCategory) {
    console.log(
      `  ${row.category.padEnd(12)} hit@3 ${row.hit}/${row.total} (${pct(row.hit, row.total)}), correct ${row.correct}/${row.total} (${pct(row.correct, row.total)})`,
    );
  }
  console.log(`p95 latency:    retrieval ${summary.p95RetrievalMs}ms, narrate ${summary.p95NarrateMs}ms, total ${summary.p95TotalMs}ms`);

  // --- Markdown + JSON report ---

  let gitCommit = "unknown";
  try {
    gitCommit = (await Bun.$`git rev-parse --short HEAD`.quiet()).text().trim();
  } catch {
    // not fatal — report still useful outside a git checkout
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const baseName = args.label ? `${dateStamp}-${args.label}-basic-eval` : `${dateStamp}-basic-eval`;
  const reportDir = new URL("../docs/eval-runs/", import.meta.url).pathname;
  const mdPath = `${reportDir}${baseName}.md`;
  const jsonPath = `${reportDir}${baseName}.json`;

  const retrievalDescriptor =
    retriever.mode === "mcp"
      ? `MCP @ ${args.mcpUrl}${args.topic ? ` (topic=${args.topic})` : ""} — query_mutual_funds (Finley's knowledge tool), full chunk text, server-default limit`
      : `in-process (embedding ${config.embedding.model} @ ${config.embedding.baseUrl}; limit=${config.search.defaultLimit}, threshold=${config.search.scoreThreshold}, candidateLimit=${config.search.candidateLimit}, rrfK=${config.search.rrfK})`;

  const mdLines: string[] = [
    `# Basic Eval — ${dateStamp}${args.label ? ` (${args.label})` : ""}`,
    "",
    `- Run at: ${new Date().toISOString()}`,
    `- Git commit: ${gitCommit}`,
    `- Golden set: ${goldenSet.version} (${results.length} cases)`,
    `- Retrieval: ${retrievalDescriptor}`,
    `- Narrate: ${config.narrate.model} @ ${config.narrate.baseUrl}`,
    "",
    "## Results",
    "",
    "| id | category | hit@3 | answer | retrieval ms | narrate ms | answer (first 120 chars) |",
    "|----|----------|-------|--------|--------------|------------|--------------------------|",
    ...results.map((item) =>
      `| ${item.id} | ${item.category} | ${item.hitAt3 ? "✅" : "❌"} | ${item.answerCorrect ? "✅" : "❌"} | ${item.retrievalMs} | ${item.narrateMs} | ${mdEscape(item.answer.slice(0, 120))} |`,
    ),
    "",
    "## Aggregates",
    "",
    `- **hit@3**: ${summary.hitAt3}/${summary.cases} (${summary.hitAt3Pct})`,
    `- **answer_correct**: ${summary.answerCorrect}/${summary.cases} (${summary.answerCorrectPct})`,
    ...(errorCount > 0 ? [`- **retrieval errors**: ${errorCount}`] : []),
    "",
    "| category | hit@3 | correct |",
    "|----------|-------|---------|",
    ...byCategory.map(
      (row) => `| ${row.category} | ${row.hit}/${row.total} (${pct(row.hit, row.total)}) | ${row.correct}/${row.total} (${pct(row.correct, row.total)}) |`,
    ),
    "",
    `- **p95 retrieval**: ${summary.p95RetrievalMs} ms`,
    `- **p95 narrate**: ${summary.p95NarrateMs} ms`,
    `- **p95 total**: ${summary.p95TotalMs} ms`,
    "",
  ];

  await Bun.write(mdPath, mdLines.join("\n"));
  await Bun.write(
    jsonPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        gitCommit,
        goldenSetVersion: goldenSet.version,
        config: {
          retrieval:
            retriever.mode === "mcp"
              ? { mode: "mcp", url: args.mcpUrl, topic: args.topic ?? null, tool: "query_mutual_funds", textMode: "full" }
              : { mode: "in-process", embedding: config.embedding, search: config.search },
          narrate: { baseUrl: config.narrate.baseUrl, model: config.narrate.model },
        },
        summary,
        results,
      },
      null,
      2,
    ),
  );

  console.log(`\nReport: ${mdPath}`);
  console.log(`Detail: ${jsonPath}`);
}

if (import.meta.main) {
  await main();
  // The pg pool (in-process mode) keeps the event loop alive; exit cleanly.
  process.exit(0);
}
