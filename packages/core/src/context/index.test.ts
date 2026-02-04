/**
 * ContextAssembler tests.
 *
 * Tests context assembly logic for RAG pipeline.
 * RED phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { ChunkPayload } from "@mf-rag/types";
import type { AssembledContext, RetrievedChunk } from "./types.ts";

// Import the class to be implemented
// This will fail until ContextAssembler is implemented
import { ContextAssembler } from "./index.ts";

// Helper to create mock search results
function createMockSearchResult(
  id: string,
  text: string,
  score: number,
  fundName: string = "Test Fund",
  pageNumbers: number[] = [1]
): { id: string; score: number; payload: ChunkPayload } {
  return {
    id,
    score,
    payload: {
      text,
      chunk_index: 0,
      total_chunks: 1,
      document_id: `doc-${id}`,
      document_filename: `${fundName.toLowerCase().replace(/\s+/g, "-")}.pdf`,
      page_numbers: pageNumbers,
      fund_name: fundName,
      amc_name: "Test AMC",
      scheme_type: "Equity",
      scheme_category: "Large Cap",
      doc_type: "SID",
      document_date: "2024-01-01",
      has_table: false,
      section_header: null,
      sebi_scheme_id: "12345",
      sebi_url: "https://example.com/scheme/12345",
    },
  };
}

describe("ContextAssembler", () => {
  let assembler: InstanceType<typeof ContextAssembler>;

  beforeEach(() => {
    assembler = new ContextAssembler();
  });

  describe("constructor", () => {
    it("should create assembler with default config", () => {
      const defaultAssembler = new ContextAssembler();
      expect(defaultAssembler).toBeDefined();
    });

    it("should create assembler with custom max tokens", () => {
      const customAssembler = new ContextAssembler({ maxTokens: 2000 });
      expect(customAssembler).toBeDefined();
    });
  });

  describe("assemble", () => {
    it("should transform search results into RetrievedChunks", () => {
      const searchResults = [
        createMockSearchResult("1", "This is test content.", 0.9, "Fund A"),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.chunks).toHaveLength(1);
      expect(context.chunks[0].id).toBe("1");
      expect(context.chunks[0].text).toBe("This is test content.");
      expect(context.chunks[0].score).toBe(0.9);
      expect(context.chunks[0].relevanceRank).toBe(1);
      expect(context.chunks[0].tokenEstimate).toBeGreaterThan(0);
    });

    it("should sort chunks by relevance score descending", () => {
      const searchResults = [
        createMockSearchResult("1", "Low relevance content.", 0.5),
        createMockSearchResult("2", "High relevance content.", 0.9),
        createMockSearchResult("3", "Medium relevance content.", 0.7),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.chunks[0].score).toBe(0.9);
      expect(context.chunks[1].score).toBe(0.7);
      expect(context.chunks[2].score).toBe(0.5);
      expect(context.chunks[0].relevanceRank).toBe(1);
      expect(context.chunks[1].relevanceRank).toBe(2);
      expect(context.chunks[2].relevanceRank).toBe(3);
    });

    it("should respect max tokens limit", () => {
      // Create chunks that together exceed limit
      const longText = "A".repeat(1000); // ~250 tokens each
      const searchResults = [
        createMockSearchResult("1", longText, 0.9),
        createMockSearchResult("2", longText, 0.8),
        createMockSearchResult("3", longText, 0.7),
        createMockSearchResult("4", longText, 0.6),
        createMockSearchResult("5", longText, 0.5),
      ];

      // With 500 max tokens, should only fit 2 chunks (~250 each)
      const customAssembler = new ContextAssembler({ maxTokens: 500 });
      const context = customAssembler.assemble(searchResults);

      expect(context.totalTokens).toBeLessThanOrEqual(500);
      expect(context.chunks.length).toBeLessThan(5);
    });

    it("should track unique funds", () => {
      const searchResults = [
        createMockSearchResult("1", "Content A", 0.9, "Fund A"),
        createMockSearchResult("2", "Content B", 0.8, "Fund B"),
        createMockSearchResult("3", "Content C", 0.7, "Fund A"),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.uniqueFunds).toContain("Fund A");
      expect(context.uniqueFunds).toContain("Fund B");
      expect(context.uniqueFunds).toHaveLength(2);
    });

    it("should track unique documents", () => {
      const searchResults = [
        createMockSearchResult("1", "Content A", 0.9, "Fund A"),
        createMockSearchResult("2", "Content B", 0.8, "Fund A"),
        createMockSearchResult("3", "Content C", 0.7, "Fund B"),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.uniqueDocuments.length).toBeGreaterThanOrEqual(1);
    });

    it("should generate formatted context string", () => {
      const searchResults = [
        createMockSearchResult("1", "Test content here.", 0.9, "Fund A", [1, 2]),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.formattedContext).toBeDefined();
      expect(context.formattedContext).toContain("Fund A");
      expect(context.formattedContext).toContain("Test content here.");
      expect(context.formattedContext).toContain("[Source 1");
    });

    it("should handle empty input", () => {
      const context = assembler.assemble([]);

      expect(context.chunks).toHaveLength(0);
      expect(context.totalTokens).toBe(0);
      expect(context.uniqueFunds).toHaveLength(0);
      expect(context.uniqueDocuments).toHaveLength(0);
      expect(context.formattedContext).toBe("");
    });
  });

  describe("deduplication", () => {
    it("should remove duplicate chunks from same document with overlapping pages", () => {
      const searchResults = [
        createMockSearchResult("1", "This is the same content.", 0.9, "Fund A", [1, 2]),
        createMockSearchResult("2", "This is the same content.", 0.8, "Fund A", [2, 3]),
      ];

      const context = assembler.assemble(searchResults);

      // Should keep only the higher-scored chunk
      expect(context.chunks).toHaveLength(1);
      expect(context.chunks[0].score).toBe(0.9);
    });

    it("should keep similar chunks from different documents", () => {
      const searchResults = [
        createMockSearchResult("1", "Common disclosure text.", 0.9, "Fund A"),
        createMockSearchResult("2", "Common disclosure text.", 0.8, "Fund B"),
      ];

      const context = assembler.assemble(searchResults);

      // Different funds, so both should be kept
      expect(context.chunks).toHaveLength(2);
    });
  });

  describe("token estimation", () => {
    it("should estimate tokens correctly", () => {
      // ~4 chars per token
      const text = "A".repeat(400); // Should be ~100 tokens
      const searchResults = [createMockSearchResult("1", text, 0.9)];

      const context = assembler.assemble(searchResults);

      // Allow some tolerance
      expect(context.chunks[0].tokenEstimate).toBeGreaterThanOrEqual(80);
      expect(context.chunks[0].tokenEstimate).toBeLessThanOrEqual(120);
    });

    it("should calculate total tokens correctly", () => {
      const text = "A".repeat(200); // ~50 tokens
      const searchResults = [
        createMockSearchResult("1", text, 0.9),
        createMockSearchResult("2", text, 0.8),
      ];

      const context = assembler.assemble(searchResults);

      expect(context.totalTokens).toBeGreaterThanOrEqual(80);
      expect(context.totalTokens).toBeLessThanOrEqual(150);
    });
  });
});
