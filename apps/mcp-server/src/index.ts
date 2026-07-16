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
import { VectorClient, type SearchFilters, type HtmlSearchFilters, type HtmlSearchResult } from "@mf-rag/vector";
import type { ApiKey } from "@mf-rag/db/schema";
import { resolveRetrievalScope } from "./retrieval-scope.ts";
import {
  adjustRetrievalScore,
  retrievalCandidateLimit,
  type RetrievalRankingProfile,
} from "./retrieval-ranking.ts";

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

/**
 * Build citations from HTML search results, deduplicating by title.
 */
function buildHtmlCitations(results: HtmlSearchResult[]) {
  const citationMap = new Map<string, {
    title: string;
    contentCategory: string;
    sourceUrl: string;
  }>();

  for (const r of results) {
    const key = r.payload.source_url;
    if (!citationMap.has(key)) {
      citationMap.set(key, {
        title: r.payload.document_title,
        contentCategory: r.payload.content_category,
        sourceUrl: r.payload.source_url,
      });
    }
  }

  return Array.from(citationMap.values());
}

/**
 * Search both chunks and html_chunks tables, merge results by score.
 */
async function dualSearch(
  queryVector: number[],
  options: {
    limit: number;
    scoreThreshold: number;
    pdfFilters?: SearchFilters;
    htmlFilters?: HtmlSearchFilters;
    searchPdf?: boolean;
    searchHtml?: boolean;
    rankingProfile?: RetrievalRankingProfile;
  }
) {
  const { limit, scoreThreshold, pdfFilters, htmlFilters, searchPdf = true, searchHtml = true, rankingProfile } = options;
  const candidateLimit = retrievalCandidateLimit(limit, rankingProfile);

  // Run both searches in parallel
  const [pdfResults, htmlResults] = await Promise.all([
    searchPdf
      ? vectorClient.searchSimilar(queryVector, {
          limit: candidateLimit,
          filters: pdfFilters && Object.keys(pdfFilters).length > 0 ? pdfFilters : undefined,
          scoreThreshold,
        })
      : Promise.resolve([]),
    searchHtml
      ? vectorClient.searchHtmlSimilar(queryVector, {
          limit: candidateLimit,
          filters: htmlFilters && Object.keys(htmlFilters).length > 0 ? htmlFilters : undefined,
          scoreThreshold,
        })
      : Promise.resolve([]),
  ]);

  // Merge and sort by score, take top N
  type MergedResult = {
    score: number;
    source_type: "scheme_document" | "knowledge_base";
    text: string;
    sectionHeader: string | null;
    // PDF-specific
    fundName?: string;
    docType?: string;
    pageNumbers?: number[];
    documentFilename?: string;
    // HTML-specific
    documentTitle?: string;
    contentCategory?: string;
    sourceUrl?: string;
  };

  const merged: MergedResult[] = [];

  for (const r of pdfResults) {
    const score = adjustRetrievalScore({
      score: r.score,
      sourceType: "scheme_document",
      text: r.payload.text,
      sectionHeader: r.payload.section_header,
      documentFilename: r.payload.document_filename,
      docType: r.payload.doc_type,
    }, rankingProfile);
    merged.push({
      score,
      source_type: "scheme_document",
      text: r.payload.text,
      sectionHeader: r.payload.section_header,
      fundName: r.payload.fund_name,
      docType: r.payload.doc_type,
      pageNumbers: r.payload.page_numbers,
      documentFilename: r.payload.document_filename,
    });
  }

  for (const r of htmlResults) {
    const score = adjustRetrievalScore({
      score: r.score,
      sourceType: "knowledge_base",
      text: r.payload.text,
      sectionHeader: r.payload.section_heading,
      contentCategory: r.payload.content_category,
    }, rankingProfile);
    merged.push({
      score,
      source_type: "knowledge_base",
      text: r.payload.text,
      sectionHeader: r.payload.section_heading,
      documentTitle: r.payload.document_title,
      contentCategory: r.payload.content_category,
      sourceUrl: r.payload.source_url,
    });
  }

  merged.sort((a, b) => b.score - a.score);

  return {
    results: merged.slice(0, limit),
    pdfResults,
    htmlResults,
  };
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
        const { results: merged, pdfResults, htmlResults } = await dualSearch(queryVector, {
          limit: config.search.defaultLimit,
          scoreThreshold: config.search.scoreThreshold,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile,
        });

        // 3. Build response with chunks and citations
        const chunks = merged.map((r, i) => ({
          rank: i + 1,
          score: parseFloat(r.score.toFixed(3)),
          source_type: r.source_type,
          text: r.text,
          sectionHeader: r.sectionHeader,
          // PDF fields (present when source_type is "scheme_document")
          ...(r.source_type === "scheme_document" && {
            fundName: r.fundName,
            docType: r.docType,
            pageNumbers: r.pageNumbers,
          }),
          // HTML fields (present when source_type is "knowledge_base")
          ...(r.source_type === "knowledge_base" && {
            documentTitle: r.documentTitle,
            contentCategory: r.contentCategory,
            sourceUrl: r.sourceUrl,
          }),
        }));

        const pdfCitations = buildCitations(pdfResults);
        const htmlCitations = buildHtmlCitations(htmlResults);
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
                      scheme_documents: pdfResults.length,
                      knowledge_base: htmlResults.length,
                    },
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
        const { results: merged } = await dualSearch(queryVector, {
          limit,
          scoreThreshold: config.search.scoreThreshold,
          pdfFilters: scope.pdfFilters,
          htmlFilters: scope.htmlFilters,
          searchPdf: scope.searchPdf,
          searchHtml: scope.searchHtml,
          rankingProfile: scope.rankingProfile,
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
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MF-RAG MCP Server running on stdio (LLM-free mode)");
    console.error(`Embedding: ${config.embedding.model} @ ${config.embedding.baseUrl}`);
  }
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
