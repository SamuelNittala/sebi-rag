/**
 * PromptBuilder tests.
 *
 * Tests prompt construction for RAG pipeline.
 * RED phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { LLMMessage } from "../llm/types.ts";
import type { AssembledContext, RetrievedChunk } from "../context/types.ts";

// Import the class to be implemented
// This will fail until PromptBuilder is implemented
import { PromptBuilder } from "./index.ts";

// Helper to create mock assembled context
function createMockContext(
  chunks: Partial<RetrievedChunk>[] = [],
  formattedContext: string = ""
): AssembledContext {
  const fullChunks: RetrievedChunk[] = chunks.map((c, idx) => ({
    id: c.id ?? `chunk-${idx}`,
    text: c.text ?? "Mock chunk text",
    score: c.score ?? 0.8,
    metadata: c.metadata ?? {
      text: c.text ?? "Mock chunk text",
      chunk_index: 0,
      total_chunks: 1,
      document_id: "doc-1",
      document_filename: "test.pdf",
      page_numbers: [1],
      fund_name: "Test Fund",
      amc_name: "Test AMC",
      scheme_type: "Equity",
      scheme_category: "Large Cap",
      doc_type: "SID",
      document_date: "2024-01-01",
      has_table: false,
      section_header: null,
      sebi_scheme_id: "12345",
      sebi_url: "https://example.com",
    },
    tokenEstimate: c.tokenEstimate ?? 50,
    relevanceRank: c.relevanceRank ?? idx + 1,
  }));

  return {
    chunks: fullChunks,
    totalTokens: fullChunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
    uniqueFunds: [...new Set(fullChunks.map((c) => c.metadata.fund_name))],
    uniqueDocuments: [...new Set(fullChunks.map((c) => c.metadata.document_id))],
    formattedContext:
      formattedContext ||
      fullChunks
        .map(
          (c, idx) =>
            `[Source ${idx + 1} - ${c.metadata.fund_name}]\n${c.text}`
        )
        .join("\n\n"),
  };
}

describe("PromptBuilder", () => {
  let builder: InstanceType<typeof PromptBuilder>;

  beforeEach(() => {
    builder = new PromptBuilder();
  });

  describe("constructor", () => {
    it("should create builder with default prompts", () => {
      const defaultBuilder = new PromptBuilder();
      expect(defaultBuilder).toBeDefined();
    });

    it("should create builder with custom system prompt", () => {
      const customBuilder = new PromptBuilder({
        systemTemplate: "Custom system prompt: {context}",
      });
      expect(customBuilder).toBeDefined();
    });
  });

  describe("build", () => {
    it("should return array of LLMMessages", () => {
      const query = "What is the expense ratio?";
      const context = createMockContext([{ text: "Expense ratio is 1.5%." }]);

      const messages = builder.build(query, context);

      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it("should include system message first", () => {
      const query = "Test query";
      const context = createMockContext([{ text: "Test content" }]);

      const messages = builder.build(query, context);

      expect(messages[0].role).toBe("system");
    });

    it("should include user message with query", () => {
      const query = "What are the risk factors?";
      const context = createMockContext([{ text: "Risk factors include..." }]);

      const messages = builder.build(query, context);

      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect(userMessage!.content).toContain("risk factors");
    });

    it("should include context in system message", () => {
      const query = "Test query";
      const context = createMockContext(
        [{ text: "Important fund information." }],
        "[Source 1 - Test Fund]\nImportant fund information."
      );

      const messages = builder.build(query, context);

      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      expect(systemMessage!.content).toContain("Important fund information");
    });

    it("should include financial domain instructions in system prompt", () => {
      const query = "Test query";
      const context = createMockContext([{ text: "Test content" }]);

      const messages = builder.build(query, context);

      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage).toBeDefined();
      // Check for key instructions
      expect(systemMessage!.content).toContain("mutual fund");
      expect(systemMessage!.content).toContain("Cite sources");
    });

    it("should handle empty context gracefully", () => {
      const query = "Test query";
      const context = createMockContext([], "");

      const messages = builder.build(query, context);

      expect(messages.length).toBeGreaterThanOrEqual(2);
      // System message should still exist
      expect(messages[0].role).toBe("system");
    });
  });

  describe("query formatting", () => {
    it("should preserve original query in user message", () => {
      const query = "What is the NAV of SBI Bluechip Fund?";
      const context = createMockContext([{ text: "NAV is Rs. 50.25" }]);

      const messages = builder.build(query, context);

      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage!.content).toContain("SBI Bluechip Fund");
      expect(userMessage!.content).toContain("NAV");
    });

    it("should handle special characters in query", () => {
      const query = "What is the expense ratio (%)? & other fees";
      const context = createMockContext([{ text: "Expense ratio: 1.5%" }]);

      const messages = builder.build(query, context);

      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage!.content).toContain("(%)");
      expect(userMessage!.content).toContain("&");
    });
  });

  describe("context formatting", () => {
    it("should include source numbers in context", () => {
      const context = createMockContext(
        [
          { text: "Content from source 1" },
          { text: "Content from source 2" },
        ],
        "[Source 1 - Fund A]\nContent from source 1\n\n[Source 2 - Fund B]\nContent from source 2"
      );

      const messages = builder.build("Query", context);

      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage!.content).toContain("[Source 1");
      expect(systemMessage!.content).toContain("[Source 2");
    });

    it("should include fund names in context", () => {
      const context = createMockContext(
        [
          {
            text: "Fund details",
            metadata: {
              text: "Fund details",
              chunk_index: 0,
              total_chunks: 1,
              document_id: "doc-1",
              document_filename: "test.pdf",
              page_numbers: [1],
              fund_name: "SBI Bluechip Fund",
              amc_name: "SBI MF",
              scheme_type: "Equity",
              scheme_category: "Large Cap",
              doc_type: "SID",
              document_date: "2024-01-01",
              has_table: false,
              section_header: null,
              sebi_scheme_id: "12345",
              sebi_url: "https://example.com",
            },
          },
        ],
        "[Source 1 - SBI Bluechip Fund (SID, Page 1)]\nFund details"
      );

      const messages = builder.build("Query", context);

      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage!.content).toContain("SBI Bluechip Fund");
    });
  });
});
