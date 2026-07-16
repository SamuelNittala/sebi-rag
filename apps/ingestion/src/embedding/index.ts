/**
 * Embedding pipeline module.
 *
 * Generates vector embeddings from text chunks using Ollama's BGE-M3 model.
 */

export {
  embedText,
  embedBatch,
  createEmbedder,
  checkOllamaHealth,
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type EmbeddingInput,
  type EmbeddingResult,
  type EmbeddingProgress,
  type ProgressCallback,
  type Embedder,
} from "./embedder.ts";

export * from "./contextual-input.ts";
