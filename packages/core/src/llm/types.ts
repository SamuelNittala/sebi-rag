/**
 * LLM service types for RAG pipeline.
 *
 * Defines configuration and message types for Ollama integration.
 */

/** Configuration for the LLM service. */
export interface LLMConfig {
  /** Model name (default: "qwen2.5:7b") */
  model: string;
  /** Ollama base URL (default: "http://localhost:11434") */
  baseUrl: string;
  /** Generation temperature (default: 0.3 for factual responses) */
  temperature: number;
  /** Maximum tokens to generate (default: 2048) */
  maxTokens: number;
}

/** Default LLM configuration values. */
export const DEFAULT_LLM_CONFIG: LLMConfig = {
  model: "qwen2.5:7b",
  baseUrl: "http://localhost:11434",
  temperature: 0.3,
  maxTokens: 2048,
};

/** Message role for chat completion. */
export type MessageRole = "system" | "user" | "assistant";

/** A single message in a conversation. */
export interface LLMMessage {
  /** Role of the message sender */
  role: MessageRole;
  /** Content of the message */
  content: string;
}

/** Response from the LLM. */
export interface LLMResponse {
  /** Generated text content */
  content: string;
  /** Model that generated the response */
  model: string;
  /** Total generation time in nanoseconds */
  totalDuration?: number;
  /** Number of tokens in the prompt */
  promptTokens?: number;
  /** Number of tokens generated */
  completionTokens?: number;
}

/** Ollama chat API request body. */
export interface OllamaChatRequest {
  model: string;
  messages: LLMMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

/** Ollama chat API response body. */
export interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}
