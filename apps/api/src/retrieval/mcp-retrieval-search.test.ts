import { describe, expect, test } from "bun:test";

import {
  McpRetrievalSearch,
  buildMcpRequestInit,
  parseRetrievalToolResult,
} from "./mcp-retrieval-search.ts";

describe("MCP review transport context", () => {
  test("attaches the protected bearer and canonical scope to the SDK request template", () => {
    const init = buildMcpRequestInit({
      apiKey: "mf_review_secret",
      tenantId: "tenant-a",
    });
    const headers = new Headers(init.headers);

    expect(headers.get("authorization")).toBe("Bearer mf_review_secret");
    expect(headers.get("x-amc-scope")).toBe("tenant-a");
  });

  test("fails closed when either review credential or scope is absent", () => {
    const endpoint = new URL("http://localhost:3001/mcp");
    expect(() => new McpRetrievalSearch(endpoint, {
      apiKey: "",
      tenantId: "tenant-a",
    })).toThrow("credential");
    expect(() => new McpRetrievalSearch(endpoint, {
      apiKey: "mf_review_secret",
      tenantId: "",
    })).toThrow("scope");
  });
});

describe("parseRetrievalToolResult", () => {
  test("parses and orders full query_mutual_funds chunks", () => {
    const parsed = parseRetrievalToolResult({
      content: [{
        type: "text",
        text: JSON.stringify({
          chunks: [
            { rank: 2, score: 0.8, source_type: "knowledge_base", text: "second" },
            {
              rank: 1,
              score: 0.98,
              chunkId: "chunk-1",
              source_type: "scheme_document",
              text: "first",
              pageNumbers: [23],
              retrievalMetadata: { factType: "investment_strategy" },
              retrievalTrace: {
                denseRank: 1,
                denseScore: 0.79,
                lexicalRank: 3,
                lexicalScore: 18.3,
                rrfScore: 0.98,
                metadataAdjustment: 0,
                metadataSignals: [],
                fusedScore: 0.98,
                preRerankRank: 2,
                rerankRank: 1,
                rerankScore: 0.98,
                finalScore: 0.98,
              },
            },
          ],
          metadata: {
            queryTimeMs: 91,
            retrieval: {
              denseCandidates: 40,
              lexicalCandidates: 40,
              fusion: "rrf",
              rrfK: 60,
              reranking: {
                applied: true,
                provider: "tei",
                model: "BAAI/bge-reranker-v2-m3",
                candidates: 20,
                fallbackReason: null,
              },
              intent: {
                factType: "investment_strategy",
                strategyId: "platinum-hybrid-long-short-fund",
                preferredDocumentScope: "strategy",
              },
            },
          },
        }),
      }],
    });

    expect(parsed.chunks.map((chunk) => chunk.rank)).toEqual([1, 2]);
    expect(parsed.chunks[0]?.chunkId).toBe("chunk-1");
    expect(parsed.chunks[0]?.pageNumbers).toEqual([23]);
    expect(parsed.intent.factType).toBe("investment_strategy");
    expect(parsed.denseCandidates).toBe(40);
    expect(parsed.reranking).toEqual({
      applied: true,
      provider: "tei",
      model: "BAAI/bge-reranker-v2-m3",
      candidates: 20,
      fallbackReason: null,
    });
    expect(parsed.chunks[0]?.retrievalTrace?.rerankRank).toBe(1);
  });

  test("rejects an MCP response without a text result", () => {
    expect(() => parseRetrievalToolResult({ content: [] })).toThrow(
      "did not return a text payload",
    );
  });
});
