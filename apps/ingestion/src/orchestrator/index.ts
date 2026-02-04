/**
 * Ingestion Orchestrator Module
 *
 * End-to-end pipeline for processing PDF documents:
 * - PDF parsing and table extraction
 * - Semantic chunking
 * - Metadata extraction
 * - Embedding generation
 * - Storage in pgvector (vectors) and PostgreSQL (metadata)
 */

export {
  // Main functions
  ingestDocument,
  ingestDirectory,
  isDocumentProcessed,
  computeFileHash,

  // Configuration
  DEFAULT_INGEST_CONFIG,

  // Types
  type IngestConfig,
  type IngestResult,
  type IngestProgress,
  type ProgressCallback,
  type DocType,
} from "./ingest.ts";
