/**
 * Vector package - pgvector client wrapper for MF PDF RAG.
 *
 * Exports:
 * - VectorClient class for full control
 * - Standalone functions for convenience
 * - Schema types and configuration
 */

// Client
export {
  VectorClient,
  type VectorClientConfig,
  initCollection,
  upsertChunks,
  searchSimilar,
  deleteByDocumentId,
  getCollectionInfo,
} from "./pgvector.ts";

// Schema and types
export {
  COLLECTION_NAME,
  VECTOR_DIMENSIONS,
  type SearchFilters,
  type TenantAccessScope,
  type SearchResult,
  type CollectionInfo,
  type ChunkWithVector,
  type ChunkPayload,
  type HtmlSearchFilters,
  type HtmlSearchResult,
  type HtmlChunkWithVector,
  type HtmlChunkPayload,
} from "./schema.ts";
