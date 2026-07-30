/**
 * RAG pipeline types.
 *
 * Defines configuration and interfaces for the RAG orchestrator.
 */

import type { LLMConfig } from "../llm/types.ts";
import type { ContextConfig } from "../context/types.ts";
import type { VectorClientConfig } from "@mf-rag/vector";
import type { FundDetectorConfig } from "../fund-detector/types.ts";
import type { TenantAccessScope } from "@mf-rag/types";

/** Embedding configuration for query embedding. */
export interface EmbeddingConfig {
  /** Model name (default: "bge-m3") */
  model: string;
  /** Ollama base URL (default: "http://localhost:11434") */
  baseUrl: string;
  /** Expected embedding dimensions (default: 1024) */
  dimensions: number;
}

/** Default embedding configuration values. */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: "bge-m3",
  baseUrl: "http://localhost:11434",
  dimensions: 1024,
};

/** Retrieval configuration. */
export interface RetrievalConfig {
  /** Maximum number of chunks to retrieve (default: 10) */
  limit: number;
  /** Minimum similarity score threshold (default: 0.5) */
  scoreThreshold: number;
}

/** Default retrieval configuration values. */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  limit: 10,
  scoreThreshold: 0.5,
};

/** Fund detection configuration for RAG pipeline. */
export interface FundDetectionConfig extends FundDetectorConfig {
  /** Enable auto-detection of fund names in queries (default: true) */
  enabled: boolean;
}

/** Default fund detection configuration. */
export const DEFAULT_FUND_DETECTION_CONFIG: FundDetectionConfig = {
  enabled: true,
  minConfidence: 0.6,
  autoFilterThreshold: 0.8,
};

/** Full RAG pipeline configuration. */
export interface RAGPipelineConfig {
  /** Mandatory tenant boundary for every repository read. */
  accessScope: TenantAccessScope;
  /** LLM configuration */
  ollama: LLMConfig;
  /** Vector store configuration (pgvector) */
  vector?: VectorClientConfig;
  /** Embedding configuration */
  embedding: EmbeddingConfig;
  /** Retrieval configuration */
  retrieval: RetrievalConfig;
  /** Context assembly configuration */
  context: ContextConfig;
  /** Fund detection configuration */
  fundDetection?: FundDetectionConfig;
}

/** Default RAG pipeline configuration. */
export const DEFAULT_RAG_CONFIG: Omit<RAGPipelineConfig, "accessScope"> = {
  ollama: {
    model: process.env.LLM_MODEL ?? "qwen2.5:7b",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    temperature: 0.1, // Low temperature for more deterministic, instruction-following responses
    maxTokens: 2048,
  },
  embedding: {
    model: "bge-m3",
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    dimensions: 1024,
  },
  retrieval: {
    limit: 10,
    scoreThreshold: 0.5,
  },
  context: {
    maxTokens: 4000,
    minScore: 0.5,
  },
  fundDetection: DEFAULT_FUND_DETECTION_CONFIG,
};
