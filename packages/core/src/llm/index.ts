/**
 * LLM service module for RAG pipeline.
 *
 * Provides Ollama integration for text generation using Qwen 2.5 7B.
 */

import type {
  LLMConfig,
  LLMMessage,
  LLMResponse,
  OllamaChatRequest,
  OllamaChatResponse,
} from "./types.ts";
import { DEFAULT_LLM_CONFIG } from "./types.ts";

// Export types
export * from "./types.ts";

// OllamaClient interface - to be implemented
export interface IOllamaClient {
  /**
   * Generate a response from the LLM.
   *
   * @param messages - Array of messages (system, user, assistant)
   * @returns LLM response with content and metadata
   */
  generate(messages: LLMMessage[]): Promise<LLMResponse>;

  /**
   * Check if Ollama is available and the model is loaded.
   *
   * @returns true if healthy, false otherwise
   */
  checkHealth(): Promise<boolean>;
}

// Placeholder constant for workspace resolution
export const LLM_MODEL = "qwen2.5:7b";

/**
 * Client for interacting with Ollama LLM API.
 *
 * Uses native fetch for Bun compatibility.
 */
export class OllamaClient implements IOllamaClient {
  private readonly config: LLMConfig;

  /**
   * Create a new OllamaClient.
   *
   * @param config - Partial configuration (merged with defaults)
   */
  constructor(config: Partial<LLMConfig> = {}) {
    this.config = {
      ...DEFAULT_LLM_CONFIG,
      ...config,
    };
  }

  /**
   * Generate a response from the LLM.
   *
   * @param messages - Array of messages (system, user, assistant)
   * @returns LLM response with content and metadata
   * @throws Error if messages array is empty
   * @throws Error on network failure or API error
   */
  async generate(messages: LLMMessage[]): Promise<LLMResponse> {
    if (messages.length === 0) {
      throw new Error("Messages array cannot be empty");
    }

    const requestBody: OllamaChatRequest = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: this.config.temperature,
        num_predict: this.config.maxTokens,
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new Error(
        `Failed to connect to Ollama: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    if (!data.message?.content) {
      throw new Error("Invalid response from Ollama: missing message content");
    }

    return {
      content: data.message.content,
      model: data.model,
      totalDuration: data.total_duration,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
    };
  }

  /**
   * Check if Ollama is available and responding.
   *
   * @returns true if healthy, false otherwise
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
