import { describe, expect, test } from "bun:test";

import { parseRetrievalToolResult } from "./mcp-retrieval-search.ts";

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
  });

  test("rejects an MCP response without a text result", () => {
    expect(() => parseRetrievalToolResult({ content: [] })).toThrow(
      "did not return a text payload",
    );
  });
});
