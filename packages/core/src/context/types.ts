/**
 * Context assembly types for RAG pipeline.
 *
 * Defines types for processing and organizing retrieved chunks
 * into a context suitable for LLM prompts.
 */

import type { ChunkPayload } from "@mf-rag/types";

/** Configuration for context assembly. */
export interface ContextConfig {
  /** Maximum tokens for assembled context (default: 4000) */
  maxTokens: number;
  /** Minimum similarity score to include chunk (default: 0.5) */
  minScore: number;
}

/** Default context configuration values. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxTokens: 4000,
  minScore: 0.5,
};

/** A retrieved chunk with additional computed fields. */
export interface RetrievedChunk {
  /** Unique chunk identifier */
  id: string;
  /** Chunk text content */
  text: string;
  /** Similarity score from vector search */
  score: number;
  /** Original chunk metadata */
  metadata: ChunkPayload;
  /** Estimated token count for this chunk */
  tokenEstimate: number;
  /** 1-based rank by relevance */
  relevanceRank: number;
}

/** Assembled context ready for prompt insertion. */
export interface AssembledContext {
  /** Deduplicated, ordered chunks */
  chunks: RetrievedChunk[];
  /** Total estimated tokens in context */
  totalTokens: number;
  /** List of unique fund names in context */
  uniqueFunds: string[];
  /** List of unique document IDs in context */
  uniqueDocuments: string[];
  /** Formatted context string ready for prompt */
  formattedContext: string;
}

/**
 * Estimate token count from text.
 * Uses ~4 characters per token heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
