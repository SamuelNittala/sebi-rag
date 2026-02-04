/**
 * Embedding pipeline tests.
 *
 * Tests cover:
 * - Single text embedding
 * - Batch embedding with progress tracking
 * - Error handling (Ollama unavailable)
 * - Dimension validation
 * - Empty input handling
 * - Config overrides
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  embedText,
  embedBatch,
  createEmbedder,
  checkOllamaHealth,
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type EmbeddingInput,
  type EmbeddingProgress,
} from "./embedder.ts";

// Mock fetch for all tests
const originalFetch = globalThis.fetch;

/**
 * Create a mock embedding vector of specified dimensions.
 */
function createMockEmbedding(dimensions: number = 1024): number[] {
  return Array.from({ length: dimensions }, (_, i) => Math.random() * 2 - 1);
}

/**
 * Create a mock fetch response for Ollama embed API.
 */
function createMockFetch(options: {
  embeddings?: number[][];
  error?: string;
  networkError?: boolean;
  delayMs?: number;
} = {}) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, options.delayMs));
    }

    if (options.networkError) {
      throw new Error("Network error: connection refused");
    }

    const urlStr = typeof url === "string" ? url : url.toString();

    // Health check endpoint
    if (urlStr.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "bge-m3" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Embed endpoint
    if (urlStr.endsWith("/api/embed")) {
      if (options.error) {
        return new Response(JSON.stringify({ error: options.error }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const body = init?.body ? JSON.parse(init.body as string) : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];

      // Generate embeddings for each input
      const embeddings = options.embeddings ?? inputs.map(() => createMockEmbedding());

      return new Response(JSON.stringify({ embeddings }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  };
}

describe("embedder", () => {
  beforeEach(() => {
    // Reset fetch to mock by default
    globalThis.fetch = createMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("DEFAULT_EMBEDDING_CONFIG", () => {
    test("has correct default values", () => {
      expect(DEFAULT_EMBEDDING_CONFIG.model).toBe("bge-m3");
      expect(DEFAULT_EMBEDDING_CONFIG.baseUrl).toBe("http://localhost:11434");
      expect(DEFAULT_EMBEDDING_CONFIG.batchSize).toBe(10);
      expect(DEFAULT_EMBEDDING_CONFIG.dimensions).toBe(1024);
    });
  });

  describe("embedText", () => {
    test("embeds a single text and returns vector", async () => {
      const text = "This is a test sentence for embedding.";
      const result = await embedText(text);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1024);
      expect(result.every(n => typeof n === "number")).toBe(true);
    });

    test("uses custom config when provided", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return createMockFetch()(url, init);
      };

      const text = "Test text";
      await embedText(text, { baseUrl: "http://custom:8080" });

      expect(capturedUrl).toContain("http://custom:8080");
    });

    test("throws on empty text", async () => {
      await expect(embedText("")).rejects.toThrow("Text cannot be empty");
    });

    test("throws on whitespace-only text", async () => {
      await expect(embedText("   ")).rejects.toThrow("Text cannot be empty");
    });

    test("validates embedding dimensions", async () => {
      // Return wrong dimensions
      globalThis.fetch = createMockFetch({
        embeddings: [createMockEmbedding(512)], // Wrong dimensions
      });

      await expect(embedText("test")).rejects.toThrow(/dimension mismatch/i);
    });

    test("throws on Ollama API error", async () => {
      globalThis.fetch = createMockFetch({ error: "Model not found" });

      await expect(embedText("test")).rejects.toThrow(/Model not found/i);
    });

    test("throws on network error", async () => {
      globalThis.fetch = createMockFetch({ networkError: true });

      await expect(embedText("test")).rejects.toThrow(/connection refused/i);
    });
  });

  describe("embedBatch", () => {
    test("embeds multiple texts and returns results with indices", async () => {
      const inputs: EmbeddingInput[] = [
        { text: "First text", chunkIndex: 0 },
        { text: "Second text", chunkIndex: 1 },
        { text: "Third text", chunkIndex: 2 },
      ];

      const results = await embedBatch(inputs);

      expect(results.length).toBe(3);
      results.forEach((result, i) => {
        expect(result.chunkIndex).toBe(i);
        expect(result.embedding.length).toBe(1024);
        expect(typeof result.tokenCount).toBe("number");
      });
    });

    test("processes in batches according to batchSize", async () => {
      let callCount = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.endsWith("/api/embed")) {
          callCount++;
        }
        return createMockFetch()(url, init);
      };

      const inputs: EmbeddingInput[] = Array.from({ length: 25 }, (_, i) => ({
        text: `Text ${i}`,
        chunkIndex: i,
      }));

      await embedBatch(inputs, { batchSize: 10 });

      // 25 inputs with batch size 10 = 3 batches (10 + 10 + 5)
      expect(callCount).toBe(3);
    });

    test("calls progress callback after each batch", async () => {
      const progressUpdates: EmbeddingProgress[] = [];
      const onProgress = (progress: EmbeddingProgress) => {
        progressUpdates.push({ ...progress });
      };

      const inputs: EmbeddingInput[] = Array.from({ length: 25 }, (_, i) => ({
        text: `Text ${i}`,
        chunkIndex: i,
      }));

      await embedBatch(inputs, { batchSize: 10 }, onProgress);

      expect(progressUpdates.length).toBe(3);

      // First batch: 10/25
      expect(progressUpdates[0].completed).toBe(10);
      expect(progressUpdates[0].total).toBe(25);
      expect(progressUpdates[0].percentage).toBe(40);

      // Second batch: 20/25
      expect(progressUpdates[1].completed).toBe(20);
      expect(progressUpdates[1].total).toBe(25);
      expect(progressUpdates[1].percentage).toBe(80);

      // Third batch: 25/25
      expect(progressUpdates[2].completed).toBe(25);
      expect(progressUpdates[2].total).toBe(25);
      expect(progressUpdates[2].percentage).toBe(100);
    });

    test("returns empty array for empty input", async () => {
      const results = await embedBatch([]);
      expect(results).toEqual([]);
    });

    test("throws on any empty text in batch", async () => {
      const inputs: EmbeddingInput[] = [
        { text: "Valid text", chunkIndex: 0 },
        { text: "", chunkIndex: 1 },
      ];

      await expect(embedBatch(inputs)).rejects.toThrow(/empty text.*index 1/i);
    });

    test("handles single item batch", async () => {
      const inputs: EmbeddingInput[] = [{ text: "Single item", chunkIndex: 42 }];

      const results = await embedBatch(inputs);

      expect(results.length).toBe(1);
      expect(results[0].chunkIndex).toBe(42);
    });

    test("preserves original chunk indices in results", async () => {
      const inputs: EmbeddingInput[] = [
        { text: "First", chunkIndex: 100 },
        { text: "Second", chunkIndex: 200 },
        { text: "Third", chunkIndex: 300 },
      ];

      const results = await embedBatch(inputs);

      expect(results[0].chunkIndex).toBe(100);
      expect(results[1].chunkIndex).toBe(200);
      expect(results[2].chunkIndex).toBe(300);
    });
  });

  describe("createEmbedder", () => {
    test("creates a reusable embedder instance", async () => {
      const embedder = createEmbedder();

      const embedding = await embedder.embed("Test text");
      expect(embedding.length).toBe(1024);

      const batchResults = await embedder.embedBatch([
        { text: "Batch text 1", chunkIndex: 0 },
        { text: "Batch text 2", chunkIndex: 1 },
      ]);
      expect(batchResults.length).toBe(2);
    });

    test("respects custom config", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return createMockFetch()(url, init);
      };

      const embedder = createEmbedder({
        baseUrl: "http://custom-ollama:11434",
        batchSize: 5,
      });

      await embedder.embed("Test");

      expect(capturedUrl).toContain("http://custom-ollama:11434");
    });

    test("embedBatch uses instance config for batch size", async () => {
      let callCount = 0;
      globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.endsWith("/api/embed")) {
          callCount++;
        }
        return createMockFetch()(url, init);
      };

      const embedder = createEmbedder({ batchSize: 3 });

      const inputs: EmbeddingInput[] = Array.from({ length: 10 }, (_, i) => ({
        text: `Text ${i}`,
        chunkIndex: i,
      }));

      await embedder.embedBatch(inputs);

      // 10 inputs with batch size 3 = 4 batches (3 + 3 + 3 + 1)
      expect(callCount).toBe(4);
    });

    test("supports progress callback in embedBatch", async () => {
      const embedder = createEmbedder({ batchSize: 5 });
      const progressUpdates: EmbeddingProgress[] = [];

      const inputs: EmbeddingInput[] = Array.from({ length: 12 }, (_, i) => ({
        text: `Text ${i}`,
        chunkIndex: i,
      }));

      await embedder.embedBatch(inputs, (progress) => {
        progressUpdates.push({ ...progress });
      });

      expect(progressUpdates.length).toBe(3); // 5 + 5 + 2
    });
  });

  describe("checkOllamaHealth", () => {
    test("returns true when Ollama is available", async () => {
      const result = await checkOllamaHealth();
      expect(result).toBe(true);
    });

    test("returns false when Ollama is unavailable", async () => {
      globalThis.fetch = createMockFetch({ networkError: true });

      const result = await checkOllamaHealth();
      expect(result).toBe(false);
    });

    test("returns false on non-200 response", async () => {
      globalThis.fetch = async () => new Response("Server error", { status: 500 });

      const result = await checkOllamaHealth();
      expect(result).toBe(false);
    });

    test("uses custom baseUrl", async () => {
      let capturedUrl = "";
      globalThis.fetch = async (url: string | URL | Request) => {
        capturedUrl = typeof url === "string" ? url : url.toString();
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      };

      await checkOllamaHealth("http://custom:9999");

      expect(capturedUrl).toBe("http://custom:9999/api/tags");
    });
  });

  describe("error handling", () => {
    test("provides meaningful error on invalid JSON response", async () => {
      globalThis.fetch = async () => new Response("not json", { status: 200 });

      await expect(embedText("test")).rejects.toThrow();
    });

    test("handles timeout-like scenarios", async () => {
      // Simulate a very slow response
      globalThis.fetch = createMockFetch({ delayMs: 100 });

      // This should still work (not a real timeout, just delayed)
      const result = await embedText("test");
      expect(result.length).toBe(1024);
    });
  });

  describe("token count estimation", () => {
    test("estimates token count based on text length", async () => {
      const inputs: EmbeddingInput[] = [
        { text: "Short", chunkIndex: 0 },
        { text: "This is a much longer sentence with more words and characters.", chunkIndex: 1 },
      ];

      const results = await embedBatch(inputs);

      // Token counts should be proportional to text length
      expect(results[0].tokenCount).toBeLessThan(results[1].tokenCount);
      expect(results[0].tokenCount).toBeGreaterThan(0);
      expect(results[1].tokenCount).toBeGreaterThan(0);
    });
  });
});
