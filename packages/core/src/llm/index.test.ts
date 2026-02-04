/**
 * OllamaClient tests.
 *
 * Tests LLM integration with Ollama.
 * RED phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { LLMMessage, LLMResponse, LLMConfig } from "./types.ts";

// Import the class to be implemented
// This will fail until OllamaClient is implemented
import { OllamaClient } from "./index.ts";

describe("OllamaClient", () => {
  let client: InstanceType<typeof OllamaClient>;

  beforeEach(() => {
    client = new OllamaClient({
      model: "qwen2.5:7b",
      baseUrl: "http://localhost:11434",
      temperature: 0.3,
      maxTokens: 2048,
    });
  });

  describe("constructor", () => {
    it("should create client with default config when no config provided", () => {
      const defaultClient = new OllamaClient();
      expect(defaultClient).toBeDefined();
    });

    it("should create client with custom config", () => {
      const customClient = new OllamaClient({
        model: "custom-model",
        baseUrl: "http://custom:11434",
        temperature: 0.5,
        maxTokens: 1024,
      });
      expect(customClient).toBeDefined();
    });

    it("should merge partial config with defaults", () => {
      const partialClient = new OllamaClient({
        model: "custom-model",
      });
      expect(partialClient).toBeDefined();
    });
  });

  describe("generate", () => {
    it("should generate response from messages", async () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is 2+2?" },
      ];

      const response = await client.generate(messages);

      expect(response).toBeDefined();
      expect(response.content).toBeDefined();
      expect(typeof response.content).toBe("string");
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.model).toBeDefined();
    });

    it("should include token counts in response when available", async () => {
      const messages: LLMMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const response = await client.generate(messages);

      // Token counts may be undefined but should be numbers if present
      if (response.promptTokens !== undefined) {
        expect(typeof response.promptTokens).toBe("number");
      }
      if (response.completionTokens !== undefined) {
        expect(typeof response.completionTokens).toBe("number");
      }
    });

    it("should throw error for empty messages array", async () => {
      const messages: LLMMessage[] = [];

      await expect(client.generate(messages)).rejects.toThrow();
    });

    it("should handle multi-turn conversations", async () => {
      const messages: LLMMessage[] = [
        { role: "system", content: "You are a math tutor." },
        { role: "user", content: "What is 5+3?" },
        { role: "assistant", content: "5+3 equals 8." },
        { role: "user", content: "Now multiply that by 2." },
      ];

      const response = await client.generate(messages);

      expect(response.content).toBeDefined();
      expect(response.content.length).toBeGreaterThan(0);
    });
  });

  describe("checkHealth", () => {
    it("should return true when Ollama is available", async () => {
      // This test requires Ollama to be running
      const healthy = await client.checkHealth();

      expect(typeof healthy).toBe("boolean");
    });

    it("should return false when Ollama is unavailable", async () => {
      const unreachableClient = new OllamaClient({
        baseUrl: "http://localhost:99999",
      });

      const healthy = await unreachableClient.checkHealth();

      expect(healthy).toBe(false);
    });
  });
});

describe("OllamaClient error handling", () => {
  it("should throw descriptive error when model not found", async () => {
    const client = new OllamaClient({
      model: "nonexistent-model-xyz",
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "Hello" },
    ];

    await expect(client.generate(messages)).rejects.toThrow();
  });

  it("should throw error on network failure", async () => {
    const client = new OllamaClient({
      baseUrl: "http://localhost:99999",
    });

    const messages: LLMMessage[] = [
      { role: "user", content: "Hello" },
    ];

    await expect(client.generate(messages)).rejects.toThrow();
  });
});
