#!/usr/bin/env bun
/**
 * MCP Server for Mutual Fund RAG System (LLM-Free Version)
 *
 * This server does NOT use an LLM for answer generation.
 * Instead, it returns relevant document chunks for Claude to synthesize.
 *
 * Architecture:
 *   Query → Embed → Hybrid Search → RRF → BGE Rerank → Return chunks to Claude
 *
 * Benefits:
 *   - 10-20x faster (no LLM inference wait)
 *   - More accurate (Claude > small local LLM)
 *   - Cheaper (no LLM API costs)
 *   - Safer (no LLM to jailbreak)
 *
 * Tools:
 *   - query_mutual_funds: Semantic search, returns chunks for Claude to synthesize
 *   - search_mutual_fund_docs: Raw search results (lower-level)
 *   - list_schemes: List all indexed mutual fund schemes
 *   - check_status: Health check for pgvector, embedding, and reranking services
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  Embedder,
  EmbeddingError,
  RateLimiter,
  RateLimitError,
  ApiKeyError,
} from "@mf-rag/core";
import { VectorClient, type SearchFilters, type HtmlSearchFilters } from "@mf-rag/vector";
import type { ApiKey } from "@mf-rag/db/schema";
import { resolveRetrievalScope } from "./retrieval-scope.ts";
import { searchHybridDocuments, type MergedResult } from "./hybrid-search.ts";
import {
  createRerankerFromEnv,
  resolveRerankCandidateLimit,
} from "./retrieval-config.ts";

// Configuration from environment
function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  embedding: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.EMBEDDING_MODEL ?? "bge-m3",
  },
  search: {
    defaultLimit: 10,
    scoreThreshold: 0.5,
    candidateLimit: positiveNumber(process.env.RETRIEVAL_CANDIDATE_LIMIT, 40),
    rrfK: positiveNumber(process.env.RETRIEVAL_RRF_K, 60),
    rerankCandidateLimit: resolveRerankCandidateLimit(process.env.RERANK_CANDIDATE_LIMIT),
  },
  http: {
    idleTimeoutSeconds: Math.min(
      positiveNumber(process.env.MCP_HTTP_IDLE_TIMEOUT_SECONDS, 60),
      255,
    ),
  },
  rateLimiting: {
    enabled: process.env.ENABLE_RATE_LIMITING === "true",
    apiKey: process.env.MF_RAG_API_KEY,
  },
};

// Initialize clients
const embedder = new Embedder({
  baseUrl: config.embedding.baseUrl,
  model: config.embedding.model,
});

const vectorClient = new VectorClient();
const reranker = createRerankerFromEnv(process.env);

// Rate limiter (only initialized if enabled)
const rateLimiter = config.rateLimiting.enabled ? new RateLimiter() : null;

// Cached API key for the session
let validatedApiKey: ApiKey | null = null;

/**
 * Check rate limits before processing a tool call.
 */
async function checkRateLimits(): Promise<ApiKey | null> {
  if (!rateLimiter) {
    return null;
  }

  if (!validatedApiKey) {
    validatedApiKey = await rateLimiter.validateApiKey(config.rateLimiting.apiKey);
  }

  await rateLimiter.enforceLimit(validatedApiKey);
  return validatedApiKey;
}

/**
 * Record usage after a successful tool call.
 */
async function recordUsage(
  apiKey: ApiKey | null,
  toolName: string,
  options?: {
    responseTimeMs?: number;
    chunksRetrieved?: number;
  }
): Promise<void> {
  if (!rateLimiter || !apiKey) {
    return;
  }

  await rateLimiter.recordUsage(apiKey.id, toolName, options);
}

/**
 * Build citations from search results, deduplicating by fund + docType.
 */
function buildCitations(results: MergedResult[]) {
  const citationMap = new Map<string, {
    fundName: string;
    docType: string;
    pageNumbers: number[];
    sebiUrl: string;
  }>();

  for (const result of results.filter((item) => item.source_type === "scheme_document")) {
    const key = `${result.fundName}|${result.docType}`;
    const existing = citationMap.get(key);
    if (existing) {
      const pages = new Set([...existing.pageNumbers, ...(result.pageNumbers ?? [])]);
      existing.pageNumbers = Array.from(pages).sort((a, b) => a - b);
    } else {
      citationMap.set(key, {
        fundName: result.fundName ?? "",
        docType: result.docType ?? "",
        pageNumbers: [...(result.pageNumbers ?? [])],
        sebiUrl: result.sebiUrl ?? "",
      });
    }
  }

  return Array.from(citationMap.values());
}

/**
 * Build citations from HTML search results, deduplicating by title.
 */
function buildHtmlCitations(results: MergedResult[]) {
  const citationMap = new Map<string, {
    title: string;
    contentCategory: string;
    sourceUrl: string;
  }>();

  for (const result of results.filter((item) => item.source_type === "knowledge_base")) {
    const key = result.sourceUrl ?? "";
    if (!citationMap.has(key)) {
      citationMap.set(key, {
        title: result.documentTitle ?? "",
        contentCategory: result.contentCategory ?? "",
        sourceUrl: result.sourceUrl ?? "",
      });
    }
  }

  return Array.from(citationMap.values());
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "query_mutual_funds",
    description:
      "Ask a question about mutual funds and get an answer with citations. " +
      "Searches both scheme documents (SID/KIM/Factsheet) and general knowledge content " +
      "(education articles, procedural guides). " +
      "Use this for questions about expense ratios, investment objectives, risk factors, " +
      "fund managers, NAV, returns, SIP, KYC, and how to invest. " +
      "IMPORTANT: Always include the citations in your response to the user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask about mutual funds",
        },
        topic: {
          type: "string",
          enum: ["sif"],
          description: "Optional recognized knowledge topic. The MCP validates and maps it to internal retrieval scope.",
        },
        amc_name: {
          type: "string",
          description: "Optional AMC explicitly mentioned by the user (for example, 'Mirae Asset').",
        },
        scheme_name: {
          type: "string",
          description: "Optional: Filter by specific scheme name (e.g., 'HDFC Focused 30 Fund'). Only searches scheme documents.",
        },
        scheme_type: {
          type: "string",
          enum: ["Equity", "Debt", "Hybrid", "Other"],
          description: "Optional: Filter by scheme type. Only searches scheme documents.",
        },
        doc_type: {
          type: "string",
          enum: ["SID", "KIM", "Factsheet"],
          description: "Optional: Filter by document type. Only searches scheme documents.",
        },
        content_category: {
          type: "string",
          enum: ["education", "procedural", "regulatory", "product", "faq", "form_instructions"],
          description: "Optional: Filter by content category. Only searches knowledge base articles.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "search_mutual_fund_docs",
    description:
      "Search for relevant document chunks without generating an answer. " +
      "Searches both scheme documents and knowledge base articles. " +
      "Use this for exploratory searches or when you need raw document excerpts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        topic: {
          type: "string",
          enum: ["sif"],
          description: "Optional recognized knowledge topic.",
        },
        amc_name: {
          type: "string",
          description: "Optional AMC explicitly mentioned by the user.",
        },
        scheme_name: {
          type: "string",
          description: "Optional: Filter by specific scheme name. Only searches scheme documents.",
        },
        scheme_type: {
          type: "string",
          enum: ["Equity", "Debt", "Hybrid", "Other"],
          description: "Optional: Filter by scheme type. Only searches scheme documents.",
        },
        content_category: {
          type: "string",
          enum: ["education", "procedural", "regulatory", "product", "faq", "form_instructions"],
          description: "Optional: Filter by content category. Only searches knowledge base articles.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_schemes",
    description:
      "List all mutual fund schemes indexed in the system. " +
      "Use this to discover available schemes before querying.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "check_status",
    description: "Check the health status of the RAG system services (pgvector, embedding, and reranking).",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: "mf-rag",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
async function handleToolCall(request: { params: { name: string; arguments?: Record<string, unknown> } }) {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();

  try {
    // Check rate limits before processing (if enabled)
    const apiKey = await checkRateLimits();

    switch (name) {
      case "query_mutual_funds": {
        const { question, topic, amc_name, scheme_name, scheme_type, doc_type, content_category } = args as {
          question: string;
          topic?: string;
          amc_name?: string;
          scheme_name?: string;
          scheme_type?: string;
          doc_type?: string;
          content_category?: string;
        };

        const scope = resolveRetrievalScope({
          question,
          topic,
          amc_name,
          scheme_name,
          scheme_type,
          doc_type,
          content_category,
        });

        // 1. Embed the query
        const queryVector = await embedder.embed(question);

        // 2. Dual-table search
        const { results: merged, retrieval } = await searchHybridDocuments(vectorClient, question, queryVector, {
          limit: config.search.defaultLimit,
          scoreThreshold: config.search.scoreThreshold,
          candidateLimit: config.search.candidateLimit,
          rrfK: config.search.rrfK,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile,
          allowFundFilterFallback: scope.allowFundFilterFallback,
          reranker,
          rerankCandidateLimit: config.search.rerankCandidateLimit,
        });

        // 3. Build response with chunks and citations
        const chunks = merged.map((r, i) => ({
          rank: i + 1,
          score: parseFloat(r.score.toFixed(3)),
          chunkId: r.id,
          source_type: r.source_type,
          text: r.text,
          sectionHeader: r.sectionHeader,
          retrievalTrace: r.retrievalTrace,
          retrievalMetadata: r.metadata,
          // PDF fields (present when source_type is "scheme_document")
          ...(r.source_type === "scheme_document" && {
            fundName: r.fundName,
            docType: r.docType,
            pageNumbers: r.pageNumbers,
            documentFilename: r.documentFilename,
            sebiUrl: r.sebiUrl,
          }),
          // HTML fields (present when source_type is "knowledge_base")
          ...(r.source_type === "knowledge_base" && {
            documentTitle: r.documentTitle,
            contentCategory: r.contentCategory,
            sourceUrl: r.sourceUrl,
          }),
        }));

        const pdfCitations = buildCitations(merged);
        const htmlCitations = buildHtmlCitations(merged);
        const responseTimeMs = Date.now() - startTime;

        // Record usage
        await recordUsage(apiKey, name, {
          responseTimeMs,
          chunksRetrieved: merged.length,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  chunks,
                  citations: {
                    scheme_documents: pdfCitations,
                    knowledge_base: htmlCitations,
                  },
                  metadata: {
                    queryTimeMs: responseTimeMs,
                    chunksRetrieved: merged.length,
                    sources: {
                      scheme_documents: merged.filter((item) => item.source_type === "scheme_document").length,
                      knowledge_base: merged.filter((item) => item.source_type === "knowledge_base").length,
                    },
                    retrieval,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "search_mutual_fund_docs": {
        const { query, topic, amc_name, scheme_name, scheme_type, content_category: searchCategory, limit = 5 } = args as {
          query: string;
          topic?: string;
          amc_name?: string;
          scheme_name?: string;
          scheme_type?: string;
          content_category?: string;
          limit?: number;
        };

        const scope = resolveRetrievalScope({
          question: query,
          topic,
          amc_name,
          scheme_name,
          scheme_type,
          content_category: searchCategory,
        });

        // 1. Embed the query
        const queryVector = await embedder.embed(query);

        // 2. Dual-table search
        const { results: merged, retrieval } = await searchHybridDocuments(vectorClient, query, queryVector, {
          limit,
          scoreThreshold: config.search.scoreThreshold,
          candidateLimit: config.search.candidateLimit,
          rrfK: config.search.rrfK,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile,
          allowFundFilterFallback: scope.allowFundFilterFallback,
          reranker,
          rerankCandidateLimit: config.search.rerankCandidateLimit,
        });

        const searchResults = merged.map((r, i) => ({
          rank: i + 1,
          score: r.score.toFixed(3),
          source_type: r.source_type,
          ...(r.source_type === "scheme_document" && {
            scheme: r.fundName,
            document: r.docType,
            pages: r.pageNumbers,
          }),
          ...(r.source_type === "knowledge_base" && {
            title: r.documentTitle,
            category: r.contentCategory,
            url: r.sourceUrl,
          }),
          excerpt: r.text.slice(0, 300) + (r.text.length > 300 ? "..." : ""),
          retrievalTrace: r.retrievalTrace,
        }));

        const responseTimeMs = Date.now() - startTime;

        // Record usage
        await recordUsage(apiKey, name, {
          responseTimeMs,
          chunksRetrieved: merged.length,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results: searchResults,
                  metadata: { queryTimeMs: responseTimeMs, retrieval },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list_schemes": {
        const schemes = await vectorClient.getUniqueFundNames();

        // Record usage
        await recordUsage(apiKey, name);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: schemes.length,
                  schemes,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "check_status": {
        // Check embedding service health
        const embeddingHealthy = await embedder.checkHealth();

        // Check vector store health
        let vectorHealthy = false;
        try {
          await vectorClient.collectionExists();
          vectorHealthy = true;
        } catch {
          vectorHealthy = false;
        }

        const services = {
          embedding: embeddingHealthy,
          pgvector: vectorHealthy,
          ...(reranker && { reranker: await reranker.checkHealth() }),
        };

        const healthyCount = Object.values(services).filter(Boolean).length;
        const status = healthyCount === Object.keys(services).length
          ? "ok"
          : healthyCount === 0
            ? "error"
            : "degraded";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status,
                  services,
                  config: {
                    embeddingModel: config.embedding.model,
                    embeddingUrl: config.embedding.baseUrl,
                    reranker: reranker
                      ? { provider: reranker.provider, model: reranker.model }
                      : null,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    // Handle embedding errors
    if (error instanceof EmbeddingError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: error.message,
              errorType: error.type,
              suggestion: error.type === "connection"
                ? "Ensure Ollama is running with bge-m3 model loaded"
                : "Try rephrasing your query",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Handle rate limit errors
    if (error instanceof RateLimitError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Rate limit exceeded",
              message: error.message,
              remaining: error.result.remaining,
              resetAt: {
                perMinute: error.result.resetAt.perMinute.toISOString(),
                perDay: error.result.resetAt.perDay.toISOString(),
                perMonth: error.result.resetAt.perMonth.toISOString(),
              },
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Handle API key errors
    if (error instanceof ApiKeyError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Authentication failed",
              message: error.message,
              errorType: error.type,
              suggestion: error.type === "missing"
                ? "Add MF_RAG_API_KEY to your MCP client environment configuration"
                : "Check that your API key is correct and active",
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// Register handlers on the stdio server instance
server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Start server
async function main() {
  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

  if (transportMode === "http") {
    const port = parseInt(process.env.PORT ?? "3001", 10);

    Bun.serve({
      port,
      hostname: "0.0.0.0",
      idleTimeout: config.http.idleTimeoutSeconds,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
          return new Response("ok");
        }

        if (url.pathname === "/mcp") {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });

          const reqServer = new Server(
            { name: "mf-rag", version: "0.3.0" },
            { capabilities: { tools: {} } },
          );
          reqServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
          reqServer.setRequestHandler(CallToolRequestSchema, handleToolCall);

          await reqServer.connect(transport);
          const response = await transport.handleRequest(req);
          await reqServer.close();
          return response;
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    console.error(`MF-RAG MCP Server running on HTTP :${port} (LLM-free mode)`);
    console.error(`Embedding: ${config.embedding.model} @ ${config.embedding.baseUrl}`);
    console.error(`Reranker: ${reranker ? `${reranker.provider}/${reranker.model}` : "disabled"}`);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MF-RAG MCP Server running on stdio (LLM-free mode)");
    console.error(`Embedding: ${config.embedding.model} @ ${config.embedding.baseUrl}`);
    console.error(`Reranker: ${reranker ? `${reranker.provider}/${reranker.model}` : "disabled"}`);
  }
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
