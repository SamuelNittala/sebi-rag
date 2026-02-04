/**
 * RAGPipeline tests.
 *
 * Integration tests for the full RAG pipeline.
 * RED phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import type {
  QueryRequest,
  SearchRequest,
  QueryResponse,
  SearchResponse,
  HealthResponse,
} from "@mf-rag/types";

// Import the class to be implemented
// This will fail until RAGPipeline is implemented
import { RAGPipeline } from "./index.ts";

describe("RAGPipeline", () => {
  let pipeline: InstanceType<typeof RAGPipeline>;

  beforeEach(() => {
    pipeline = new RAGPipeline({});
  });

  describe("constructor", () => {
    it("should create pipeline with default config", () => {
      const defaultPipeline = new RAGPipeline({});
      expect(defaultPipeline).toBeDefined();
    });

    it("should create pipeline with custom config", () => {
      const customPipeline = new RAGPipeline({
        ollama: {
          model: "custom-model",
          baseUrl: "http://localhost:11434",
          temperature: 0.5,
          maxTokens: 1024,
        },
        retrieval: {
          limit: 5,
          scoreThreshold: 0.6,
        },
        context: {
          maxTokens: 2000,
          minScore: 0.5,
        },
      });
      expect(customPipeline).toBeDefined();
    });
  });

  describe("query", () => {
    it("should return QueryResponse with answer and citations", async () => {
      const request: QueryRequest = {
        query: "What is the expense ratio of mutual funds?",
      };

      const response = await pipeline.query(request);

      expect(response).toBeDefined();
      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.citations).toBeDefined();
      expect(Array.isArray(response.citations)).toBe(true);
      expect(response.metadata).toBeDefined();
    });

    it("should include valid citations in response", async () => {
      const request: QueryRequest = {
        query: "What are the investment objectives?",
      };

      const response = await pipeline.query(request);

      if (response.citations.length > 0) {
        const citation = response.citations[0];
        expect(citation.index).toBeGreaterThanOrEqual(1);
        expect(citation.documentId).toBeDefined();
        expect(citation.fundName).toBeDefined();
        expect(citation.pageNumbers).toBeDefined();
        expect(Array.isArray(citation.pageNumbers)).toBe(true);
        expect(citation.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(citation.relevanceScore).toBeLessThanOrEqual(1);
      }
    });

    it("should include metadata in response", async () => {
      const request: QueryRequest = {
        query: "What is the NAV?",
      };

      const response = await pipeline.query(request);

      expect(response.metadata.queryTimeMs).toBeDefined();
      expect(typeof response.metadata.queryTimeMs).toBe("number");
      expect(response.metadata.chunksRetrieved).toBeDefined();
      expect(response.metadata.chunksUsed).toBeDefined();
      expect(response.metadata.model).toBeDefined();
    });

    it("should apply filters when provided", async () => {
      const request: QueryRequest = {
        query: "What are the risk factors?",
        filters: {
          schemeType: "Equity",
        },
      };

      const response = await pipeline.query(request);

      expect(response).toBeDefined();
      // All citations should be from Equity funds
      for (const citation of response.citations) {
        // This would need actual filtering logic in implementation
        expect(citation).toBeDefined();
      }
    });

    it("should respect limit parameter", async () => {
      const request: QueryRequest = {
        query: "Investment strategy",
        limit: 3,
      };

      const response = await pipeline.query(request);

      expect(response.metadata.chunksRetrieved).toBeLessThanOrEqual(3);
    });

    it("should handle empty query with error", async () => {
      const request: QueryRequest = {
        query: "",
      };

      await expect(pipeline.query(request)).rejects.toThrow();
    });

    it("should indicate when no relevant information found", async () => {
      const request: QueryRequest = {
        query: "What is the NAV of XYZ Nonexistent Fund?",
        filters: {
          fundName: "XYZ Nonexistent Fund",
        },
      };

      const response = await pipeline.query(request);

      // Should either have empty citations or indicate no info
      if (response.citations.length === 0) {
        expect(response.answer.toLowerCase()).toMatch(
          /don't have|no information|not found|cannot find/
        );
      }
    });
  });

  describe("search", () => {
    it("should return SearchResponse with results", async () => {
      const request: SearchRequest = {
        query: "expense ratio",
      };

      const response = await pipeline.search(request);

      expect(response).toBeDefined();
      expect(response.results).toBeDefined();
      expect(Array.isArray(response.results)).toBe(true);
    });

    it("should return results with correct structure", async () => {
      const request: SearchRequest = {
        query: "investment objective",
      };

      const response = await pipeline.search(request);

      if (response.results.length > 0) {
        const result = response.results[0];
        expect(result.chunkId).toBeDefined();
        expect(result.text).toBeDefined();
        expect(result.score).toBeDefined();
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.metadata).toBeDefined();
      }
    });

    it("should sort results by score descending", async () => {
      const request: SearchRequest = {
        query: "mutual fund",
        limit: 10,
      };

      const response = await pipeline.search(request);

      if (response.results.length > 1) {
        for (let i = 0; i < response.results.length - 1; i++) {
          expect(response.results[i].score).toBeGreaterThanOrEqual(
            response.results[i + 1].score
          );
        }
      }
    });

    it("should apply filters to search", async () => {
      const request: SearchRequest = {
        query: "risk factors",
        filters: {
          docType: "SID",
        },
      };

      const response = await pipeline.search(request);

      for (const result of response.results) {
        expect(result.metadata.doc_type).toBe("SID");
      }
    });

    it("should respect limit parameter", async () => {
      const request: SearchRequest = {
        query: "fund",
        limit: 5,
      };

      const response = await pipeline.search(request);

      expect(response.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe("checkHealth", () => {
    it("should return HealthResponse", async () => {
      const response = await pipeline.checkHealth();

      expect(response).toBeDefined();
      expect(response.status).toBeDefined();
      expect(["ok", "degraded", "error"]).toContain(response.status);
    });

    it("should check all services", async () => {
      const response = await pipeline.checkHealth();

      expect(response.services).toBeDefined();
      expect(typeof response.services.vector).toBe("boolean");
      expect(typeof response.services.postgres).toBe("boolean");
      expect(typeof response.services.ollama).toBe("boolean");
    });

    it("should return degraded when some services are down", async () => {
      // This test verifies the status logic
      // Implementation should return "degraded" if some but not all services fail
      const response = await pipeline.checkHealth();

      if (response.status === "degraded") {
        const services = Object.values(response.services);
        const someUp = services.some((s) => s);
        const someDown = services.some((s) => !s);
        expect(someUp && someDown).toBe(true);
      }
    });
  });
});

describe("RAGPipeline ambiguous query handling", () => {
  let pipeline: InstanceType<typeof RAGPipeline>;

  beforeEach(() => {
    pipeline = new RAGPipeline({});
  });

  it("should return clarification for ambiguous queries", async () => {
    // Initialize fund detector with test data
    await pipeline.initFundDetector();

    const request: QueryRequest = {
      query: "What is the expense ratio of HDFC fund?",
    };

    const response = await pipeline.query(request);

    // If multiple HDFC funds are indexed, should ask for clarification
    if (response.metadata.clarificationNeeded) {
      expect(response.metadata.ambiguousMatches).toBeDefined();
      expect(response.metadata.ambiguousMatches!.length).toBeGreaterThan(1);
      expect(response.answer).toContain("multiple funds");
      expect(response.citations).toHaveLength(0);
    }
  });

  it("should include ambiguousMatches in metadata when clarifying", async () => {
    await pipeline.initFundDetector();

    const request: QueryRequest = {
      query: "Tell me about HDFC fund expense ratio",
    };

    const response = await pipeline.query(request);

    if (response.metadata.clarificationNeeded) {
      expect(response.metadata.ambiguousMatches).toBeDefined();
      for (const match of response.metadata.ambiguousMatches!) {
        expect(match.fundName).toBeDefined();
        expect(match.confidence).toBeGreaterThanOrEqual(0);
        expect(match.autoApplied).toBe(false);
      }
    }
  });

  it("should proceed without clarification for comparison queries", async () => {
    await pipeline.initFundDetector();

    const request: QueryRequest = {
      query: "Compare HDFC Focused 30 Fund and SBI Bluechip Fund expense ratios",
    };

    const response = await pipeline.query(request);

    // Comparison queries should NOT trigger clarification
    expect(response.metadata.clarificationNeeded).toBeFalsy();
    // Should have proceeded with the query
    expect(response.answer).toBeDefined();
  });

  it("should not ask for clarification when single fund is mentioned", async () => {
    await pipeline.initFundDetector();

    const request: QueryRequest = {
      query: "What is the expense ratio of HDFC Focused 30 Fund?",
    };

    const response = await pipeline.query(request);

    // Single specific fund should not trigger clarification
    expect(response.metadata.clarificationNeeded).toBeFalsy();
  });
});

describe("RAGPipeline edge cases", () => {
  let pipeline: InstanceType<typeof RAGPipeline>;

  beforeEach(() => {
    pipeline = new RAGPipeline({});
  });

  it("should handle very long queries by truncating", async () => {
    const longQuery = "A".repeat(2000);
    const request: QueryRequest = {
      query: longQuery,
    };

    // Should not throw, but truncate internally
    const response = await pipeline.query(request);
    expect(response).toBeDefined();
  });

  it("should handle special characters in query", async () => {
    const request: QueryRequest = {
      query: "What is the % return & expense ratio?",
    };

    const response = await pipeline.query(request);
    expect(response).toBeDefined();
  });

  it("should handle queries with fund name mentions", async () => {
    const request: QueryRequest = {
      query: "Tell me about SBI Bluechip Fund's investment strategy",
    };

    const response = await pipeline.query(request);
    expect(response).toBeDefined();
    // Future: should auto-filter by detected fund name
  });
});
