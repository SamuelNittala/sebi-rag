/**
 * Embedding service for query and document embedding.
 *
 * Uses Ollama's BGE-M3 model for generating dense embeddings.
 * This is a standalone module that can be used independently of RAGPipeline.
 */

/** BGE-M3 embedding dimensions */
export const EMBEDDING_MODEL = "bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

/** Embedder configuration options. */
export interface EmbedderConfig {
  /** Ollama base URL (default: http://localhost:11434) */
  baseUrl?: string;
  /** Model name (default: bge-m3) */
  model?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/** Ollama embed API response structure. */
interface OllamaEmbedResponse {
  embeddings?: number[][];
  error?: string;
}

/** Custom error for embedding failures. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly type: "NaN" | "timeout" | "connection" | "unknown"
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * Embedder class for generating text embeddings via Ollama.
 *
 * Supports single query embedding and batch embedding.
 * Handles errors gracefully with typed error responses.
 */
export class Embedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeout: number;

  constructor(config: EmbedderConfig = {}) {
    this.baseUrl = config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    this.model = config.model ?? EMBEDDING_MODEL;
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Embed a single text string.
   *
   * @param text - Text to embed
   * @returns Embedding vector (1024 dimensions for BGE-M3)
   * @throws EmbeddingError if embedding fails
   */
  async embed(text: string): Promise<number[]> {
    const embeddings = await this.embedBatch([text]);
    // embedBatch guarantees at least one result for non-empty input
    return embeddings[0]!;
  }

  /**
   * Embed multiple text strings in a single request.
   *
   * @param texts - Array of texts to embed
   * @returns Array of embedding vectors
   * @throws EmbeddingError if embedding fails
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts.length === 1 ? texts[0] : texts,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");

        // Check for NaN error (embedding model instability)
        if (errorText.includes("NaN") || errorText.includes("unsupported value")) {
          throw new EmbeddingError(
            "Text caused embedding instability. Please rephrase.",
            "NaN"
          );
        }

        throw new EmbeddingError(
          `Embedding request failed (${response.status}): ${errorText}`,
          "unknown"
        );
      }

      const data = (await response.json()) as OllamaEmbedResponse;

      if (data.error) {
        throw new EmbeddingError(`Embedding error: ${data.error}`, "unknown");
      }

      if (!data.embeddings || data.embeddings.length === 0) {
        throw new EmbeddingError(
          "Invalid embedding response: missing embeddings",
          "unknown"
        );
      }

      return data.embeddings;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof EmbeddingError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new EmbeddingError(
            `Embedding request timed out after ${this.timeout}ms`,
            "timeout"
          );
        }

        if (error.message.includes("ECONNREFUSED") || error.message.includes("fetch failed")) {
          throw new EmbeddingError(
            `Cannot connect to Ollama at ${this.baseUrl}. Is Ollama running?`,
            "connection"
          );
        }
      }

      throw new EmbeddingError(
        `Unexpected embedding error: ${error instanceof Error ? error.message : String(error)}`,
        "unknown"
      );
    }
  }

  /**
   * Check if the embedding service is healthy.
   *
   * @returns true if Ollama is reachable and model is available
   */
  async checkHealth(): Promise<boolean> {
    try {
      // Try to embed an empty-ish string to verify model is loaded
      await this.embed("test");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the model name being used.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get the base URL being used.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}
