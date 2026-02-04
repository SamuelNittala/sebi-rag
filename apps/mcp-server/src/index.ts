#!/usr/bin/env bun
/**
 * MCP Server for Mutual Fund RAG System (LLM-Free Version)
 *
 * This server does NOT use an LLM for answer generation.
 * Instead, it returns relevant document chunks for Claude to synthesize.
 *
 * Architecture:
 *   Query → Embed (bge-m3) → Vector Search (pgvector) → Return chunks to Claude
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
 *   - check_status: Health check for pgvector and Ollama embedding service
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { VectorClient, type SearchFilters } from "@mf-rag/vector";
import type { ApiKey } from "@mf-rag/db/schema";

// Configuration from environment
const config = {
  embedding: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    model: process.env.EMBEDDING_MODEL ?? "bge-m3",
  },
  search: {
    defaultLimit: 10,
    scoreThreshold: 0.5,
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
function buildCitations(results: Awaited<ReturnType<typeof vectorClient.searchSimilar>>) {
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

  return Array.from(citationMap.values());
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "query_mutual_funds",
    description:
      "Ask a question about mutual fund documents and get an answer with citations. " +
      "Use this for questions about expense ratios, investment objectives, risk factors, " +
      "fund managers, NAV, returns, and other scheme information. " +
      "IMPORTANT: Always include the citations in your response to the user, " +
      "showing the scheme name, document type, page numbers, and SEBI URL for each source.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask about mutual funds",
        },
        scheme_name: {
          type: "string",
          description: "Optional: Filter by specific scheme name (e.g., 'HDFC Focused 30 Fund')",
        },
        scheme_type: {
          type: "string",
          enum: ["Equity", "Debt", "Hybrid", "Other"],
          description: "Optional: Filter by scheme type",
        },
        doc_type: {
          type: "string",
          enum: ["SID", "KIM", "Factsheet"],
          description: "Optional: Filter by document type",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "search_mutual_fund_docs",
    description:
      "Search for relevant document chunks without generating an answer. " +
      "Use this for exploratory searches or when you need raw document excerpts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        scheme_name: {
          type: "string",
          description: "Optional: Filter by specific scheme name",
        },
        scheme_type: {
          type: "string",
          enum: ["Equity", "Debt", "Hybrid", "Other"],
          description: "Optional: Filter by scheme type",
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
    description: "Check the health status of the RAG system services (pgvector, Ollama embedding).",
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
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();

  try {
    // Check rate limits before processing (if enabled)
    const apiKey = await checkRateLimits();

    switch (name) {
      case "query_mutual_funds": {
        const { question, scheme_name, scheme_type, doc_type } = args as {
          question: string;
          scheme_name?: string;
          scheme_type?: string;
          doc_type?: string;
        };

        // Build filters
        const filters: SearchFilters = {};
        if (scheme_name) filters.fund_name = scheme_name;
        if (scheme_type) filters.scheme_type = scheme_type;
        if (doc_type) filters.doc_type = doc_type;

        // 1. Embed the query
        const queryVector = await embedder.embed(question);

        // 2. Search pgvector
        const results = await vectorClient.searchSimilar(queryVector, {
          limit: config.search.defaultLimit,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          scoreThreshold: config.search.scoreThreshold,
        });

        // 3. Build response with chunks and citations
        const chunks = results.map((r, i) => ({
          rank: i + 1,
          score: parseFloat(r.score.toFixed(3)),
          text: r.payload.text,
          fundName: r.payload.fund_name,
          docType: r.payload.doc_type,
          pageNumbers: r.payload.page_numbers,
          sectionHeader: r.payload.section_header,
        }));

        const citations = buildCitations(results);
        const responseTimeMs = Date.now() - startTime;

        // Record usage
        await recordUsage(apiKey, name, {
          responseTimeMs,
          chunksRetrieved: results.length,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  chunks,
                  citations,
                  metadata: {
                    queryTimeMs: responseTimeMs,
                    chunksRetrieved: results.length,
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
        const { query, scheme_name, scheme_type, limit = 5 } = args as {
          query: string;
          scheme_name?: string;
          scheme_type?: string;
          limit?: number;
        };

        // Build filters
        const filters: SearchFilters = {};
        if (scheme_name) filters.fund_name = scheme_name;
        if (scheme_type) filters.scheme_type = scheme_type;

        // 1. Embed the query
        const queryVector = await embedder.embed(query);

        // 2. Search pgvector
        const results = await vectorClient.searchSimilar(queryVector, {
          limit,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          scoreThreshold: config.search.scoreThreshold,
        });

        const searchResults = results.map((r, i) => ({
          rank: i + 1,
          score: r.score.toFixed(3),
          scheme: r.payload.fund_name,
          document: r.payload.doc_type,
          pages: r.payload.page_numbers,
          excerpt: r.payload.text.slice(0, 300) + (r.payload.text.length > 300 ? "..." : ""),
        }));

        const responseTimeMs = Date.now() - startTime;

        // Record usage
        await recordUsage(apiKey, name, {
          responseTimeMs,
          chunksRetrieved: results.length,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results: searchResults,
                  metadata: { queryTimeMs: responseTimeMs },
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
        };

        const healthyCount = Object.values(services).filter(Boolean).length;
        const status = healthyCount === 2 ? "ok" : healthyCount === 0 ? "error" : "degraded";

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
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MF-RAG MCP Server running on stdio (LLM-free mode)");
  console.error(`Embedding: ${config.embedding.model} @ ${config.embedding.baseUrl}`);
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
