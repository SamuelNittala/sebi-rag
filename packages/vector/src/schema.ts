/**
 * Vector store schema and configuration for MF PDF RAG system.
 *
 * Uses PostgreSQL + pgvector for vector storage:
 * - BGE-M3 embeddings (1024 dimensions)
 * - Cosine distance for similarity
 * - SQL indexes for efficient filtering
 */

import type {
  ChunkPayload,
  HtmlChunkPayload,
  TenantAccessScope,
} from "@mf-rag/types";

// Re-export payload types for convenience
export type { ChunkPayload, HtmlChunkPayload, TenantAccessScope };

/** BGE-M3 embedding dimensions */
export const VECTOR_DIMENSIONS = 1024;

/** Collection/table name */
export const COLLECTION_NAME = "chunks";

/**
 * Search filters for querying chunks.
 * All fields are optional and combined with AND logic.
 */
export interface SearchFilters {
  fund_name?: string;
  amc_name?: string;
  scheme_type?: string;
  scheme_category?: string;
  doc_type?: string;
  document_id?: string;
  date_from?: string;
  date_to?: string;
  knowledge_domain?: string;
  source_collection?: string;
  amc_slug?: string;
}

/**
 * Search result with score and payload.
 */
export interface SearchResult {
  id: string;
  score: number;
  payload: ChunkPayload;
}

/**
 * Collection statistics.
 */
export interface CollectionInfo {
  name: string;
  vectors_count: number;
  indexed_vectors_count: number;
  points_count: number;
  status: string;
}

/**
 * Chunk with embedding vector ready for upsert.
 */
export interface ChunkWithVector {
  id: string;
  vector: number[];
  payload: ChunkPayload;
}

/**
 * Search filters for querying HTML chunks.
 */
export interface HtmlSearchFilters {
  /** Single category, or a set of allowed categories (matched with IN). */
  content_category?: string | string[];
  document_id?: string;
  knowledge_domain?: string;
  source_collection?: string;
  amc_slug?: string;
}

/**
 * Search result from html_chunks table.
 */
export interface HtmlSearchResult {
  id: string;
  score: number;
  payload: HtmlChunkPayload;
}

/**
 * HTML chunk with embedding vector ready for upsert.
 */
export interface HtmlChunkWithVector {
  id: string;
  vector: number[];
  payload: HtmlChunkPayload;
}
