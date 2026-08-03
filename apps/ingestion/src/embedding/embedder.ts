/**
 * Embedding pipeline for MF-RAG system.
 *
 * Generates vector embeddings from text chunks using Ollama's BGE-M3 model.
 * Features:
 * - Batch embedding with rate limiting to avoid OOM
 * - Progress tracking for large documents
 * - Dimension validation
 * - Configurable batch sizes and model parameters
 */

/** Configuration for the embedding pipeline. */
export interface EmbeddingConfig {
  /** Model name (default: 'bge-m3') */
  model: string;
  /** Ollama base URL (default: 'http://localhost:11434') */
  baseUrl: string;
  /** Number of chunks per batch (default: 10) */
  batchSize: number;
  /** Expected embedding dimensions (default: 1024) */
  dimensions: number;
  /** Maximum time to wait for an Ollama embedding response in milliseconds. */
  timeoutMs: number;
}

/** Input for batch embedding. */
export interface EmbeddingInput {
  /** Text to embed */
  text: string;
  /** Index of the chunk in the document */
  chunkIndex: number;
}

/** Result of embedding a single chunk. */
export interface EmbeddingResult {
  /** Index of the chunk in the document */
  chunkIndex: number;
  /** Embedding vector */
  embedding: number[];
  /** Estimated token count */
  tokenCount: number;
}

/** Progress information for batch embedding. */
export interface EmbeddingProgress {
  /** Number of chunks completed */
  completed: number;
  /** Total number of chunks */
  total: number;
  /** Percentage complete (0-100) */
  percentage: number;
}

/** Callback for progress updates during batch embedding. */
export type ProgressCallback = (progress: EmbeddingProgress) => void;

/** Default configuration values. */
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: "bge-m3",
  baseUrl: "http://localhost:11434",
  batchSize: 10,
  dimensions: 1024,
  timeoutMs: 30_000,
};

/** Ollama embed API response. */
interface OllamaEmbedResponse {
  embeddings: number[][];
  error?: string;
}

/**
 * Estimate token count from text.
 * Uses a simple heuristic: ~4 characters per token on average for English text.
 */
function estimateTokenCount(text: string): number {
  // Rough estimate: ~4 characters per token for English text
  // This is a reasonable approximation for most embedding models
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Split text in half for fallback when NaN is encountered
 */
function splitTextInHalf(text: string): [string, string] {
  const midpoint = Math.floor(text.length / 2);
  // Try to split at a word boundary
  const beforeMid = text.lastIndexOf(" ", midpoint);
  const afterMid = text.indexOf(" ", midpoint);

  const splitPoint = beforeMid > 0 && (midpoint - beforeMid < afterMid - midpoint)
    ? beforeMid
    : afterMid > 0
    ? afterMid
    : midpoint;

  return [text.slice(0, splitPoint).trim(), text.slice(splitPoint).trim()];
}

/**
 * Average two embedding vectors
 */
function averageEmbeddings(emb1: number[], emb2: number[]): number[] {
  return emb1.map((val, idx) => (val + emb2[idx]) / 2);
}

/**
 * Call Ollama embed API.
 *
 * @param texts - Array of texts to embed (or single text)
 * @param config - Embedding configuration
 * @param retryOnNaN - Whether to retry with split text on NaN (default: true)
 * @returns Array of embedding vectors
 */
async function callOllamaEmbed(
  texts: string[],
  config: EmbeddingConfig,
  retryOnNaN: boolean = true
): Promise<number[][]> {
  const url = `${config.baseUrl}/api/embed`;

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: texts.length === 1 ? texts[0] : texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    // Check if it's a NaN error and we should retry
    if (retryOnNaN && errorText.includes("NaN")) {
      // If it's a single text, split and retry
      if (texts.length === 1 && texts[0].length > 50) {
        const [part1, part2] = splitTextInHalf(texts[0]);

        // Ensure both parts are substantial enough to embed
        if (part1.length > 20 && part2.length > 20) {
          console.warn(`⚠️  NaN error detected, splitting text (${texts[0].length} chars → ${part1.length} + ${part2.length})...`);

          try {
            // Recursively embed both halves (without retry to avoid infinite loop)
            const [emb1] = await callOllamaEmbed([part1], config, false);
            const [emb2] = await callOllamaEmbed([part2], config, false);

            // Average the two embeddings
            return [averageEmbeddings(emb1, emb2)];
          } catch (splitError) {
            console.warn("⚠️  Split embedding failed; refusing to publish an invalid vector");
            throw splitError;
          }
        } else {
          throw new Error(
            `Ollama returned NaN for an input too short to split safely (${texts[0].length} chars).`,
          );
        }
      }

      // If it's a batch, try each text individually to find the problematic one
      if (texts.length > 1) {
        console.warn(`⚠️  NaN error in batch of ${texts.length}, retrying individually...`);

        const results: number[][] = [];
        for (const text of texts) {
          // Retry each text individually (with retry enabled)
          const [embedding] = await callOllamaEmbed([text], config, true);
          results.push(embedding);
        }
        return results;
      }
    }

    throw new Error(`Ollama API error (${response.status}): ${errorText}`);
  }

  const data: OllamaEmbedResponse = await response.json();

  if (data.error) {
    throw new Error(`Ollama API error: ${data.error}`);
  }

  // Validate dimensions and check for NaN values
  for (let i = 0; i < data.embeddings.length; i++) {
    const embedding = data.embeddings[i];

    if (embedding.length !== config.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${config.dimensions}, got ${embedding.length}`
      );
    }

    // Check for NaN values in the embedding
    const hasNaN = embedding.some(val => isNaN(val));
    if (hasNaN) {
      // If retry is enabled and this is a single text, try splitting
      if (retryOnNaN && texts.length === 1 && texts[0].length > 50) {
        console.warn(`⚠️  NaN detected in embedding, splitting text and retrying...`);

        const [part1, part2] = splitTextInHalf(texts[0]);

        // Recursively embed both halves (without retry to avoid infinite loop)
        const [emb1] = await callOllamaEmbed([part1], config, false);
        const [emb2] = await callOllamaEmbed([part2], config, false);

        // Average the two embeddings
        return [averageEmbeddings(emb1, emb2)];
      }

      throw new Error(
        `Embedding contains NaN values for input ${i + 1}/${data.embeddings.length}. ` +
        `This is a known issue with the bge-m3 model for certain text patterns.`
      );
    }
  }

  return data.embeddings;
}

/**
 * Embed a single text string.
 *
 * @param text - Text to embed
 * @param config - Optional partial configuration
 * @returns Embedding vector (1024 dimensions)
 * @throws Error if text is empty or embedding fails
 */
export async function embedText(
  text: string,
  config?: Partial<EmbeddingConfig>
): Promise<number[]> {
  const fullConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };

  // Validate input
  if (!text || text.trim().length === 0) {
    throw new Error("Text cannot be empty");
  }

  const embeddings = await callOllamaEmbed([text], fullConfig);
  return embeddings[0];
}

/**
 * Embed multiple texts in batches with progress tracking.
 *
 * @param inputs - Array of text inputs with chunk indices
 * @param config - Optional partial configuration
 * @param onProgress - Optional callback for progress updates
 * @returns Array of embedding results with chunk indices and token counts
 * @throws Error if any input text is empty or embedding fails
 */
export async function embedBatch(
  inputs: EmbeddingInput[],
  config?: Partial<EmbeddingConfig>,
  onProgress?: ProgressCallback
): Promise<EmbeddingResult[]> {
  // Handle empty input
  if (inputs.length === 0) {
    return [];
  }

  const fullConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };

  // Validate all inputs
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input.text || input.text.trim().length === 0) {
      throw new Error(`Empty text found at index ${i}`);
    }
  }

  const results: EmbeddingResult[] = [];
  const total = inputs.length;
  let completed = 0;

  // Process in batches
  for (let i = 0; i < inputs.length; i += fullConfig.batchSize) {
    const batch = inputs.slice(i, i + fullConfig.batchSize);
    const texts = batch.map((input) => input.text);

    // Call Ollama API for this batch
    const embeddings = await callOllamaEmbed(texts, fullConfig);

    // Create results for this batch
    for (let j = 0; j < batch.length; j++) {
      results.push({
        chunkIndex: batch[j].chunkIndex,
        embedding: embeddings[j],
        tokenCount: estimateTokenCount(batch[j].text),
      });
    }

    // Update progress
    completed += batch.length;
    if (onProgress) {
      onProgress({
        completed,
        total,
        percentage: Math.round((completed / total) * 100),
      });
    }
  }

  return results;
}

/** Reusable embedder instance interface. */
export interface Embedder {
  /** Embed a single text string. */
  embed: (text: string) => Promise<number[]>;
  /** Embed multiple texts in batches with progress tracking. */
  embedBatch: (
    inputs: EmbeddingInput[],
    onProgress?: ProgressCallback
  ) => Promise<EmbeddingResult[]>;
}

/**
 * Create a reusable embedder instance with fixed configuration.
 *
 * @param config - Optional partial configuration
 * @returns Embedder instance with embed and embedBatch methods
 */
export function createEmbedder(config?: Partial<EmbeddingConfig>): Embedder {
  const fullConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };

  return {
    embed: (text: string) => embedText(text, fullConfig),
    embedBatch: (inputs: EmbeddingInput[], onProgress?: ProgressCallback) =>
      embedBatch(inputs, fullConfig, onProgress),
  };
}

/**
 * Check if Ollama is available and responding.
 *
 * @param baseUrl - Optional base URL (default: http://localhost:11434)
 * @returns true if Ollama is healthy, false otherwise
 */
export async function checkOllamaHealth(
  baseUrl: string = DEFAULT_EMBEDDING_CONFIG.baseUrl
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}
