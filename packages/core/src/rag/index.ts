/**
 * RAG pipeline orchestrator module.
 *
 * Coordinates all components to answer queries:
 * 1. Embed query using BGE-M3
 * 2. Retrieve relevant chunks from pgvector
 * 3. Assemble context within token budget
 * 4. Build prompt with financial domain instructions
 * 5. Generate response using Qwen 2.5 7B
 * 6. Return answer with citations
 */

import type {
  QueryRequest,
  SearchRequest,
  QueryResponse,
  SearchResponse,
  HealthResponse,
  Citation,
  QueryFilters,
  DetectedFund,
} from "@mf-rag/types";

import { OllamaClient } from "../llm/index.ts";
import { ContextAssembler, type SearchResult } from "../context/index.ts";
import { PromptBuilder } from "../prompt/index.ts";
import {
  VectorClient,
  type SearchFilters,
  type TenantAccessScope,
} from "@mf-rag/vector";

import {
  type RAGPipelineConfig,
  DEFAULT_RAG_CONFIG,
  type EmbeddingConfig,
  DEFAULT_EMBEDDING_CONFIG,
  type RetrievalConfig,
  DEFAULT_RETRIEVAL_CONFIG,
  type FundDetectionConfig,
  DEFAULT_FUND_DETECTION_CONFIG,
} from "./types.ts";
import { FundDetector, type DetectionResult } from "../fund-detector/index.ts";
import { OutputValidator, REJECTION_MESSAGE } from "../validator/index.ts";

// Export types
export * from "./types.ts";

// RAGPipeline interface - to be implemented
export interface IRAGPipeline {
  /**
   * Process a query and generate an answer with citations.
   *
   * @param request - Query request with question and optional filters
   * @returns Response with answer, citations, and metadata
   */
  query(request: QueryRequest): Promise<QueryResponse>;

  /**
   * Search for relevant chunks without generating an answer.
   *
   * @param request - Search request with query and optional filters
   * @returns Search results with chunk text, scores, and metadata
   */
  search(request: SearchRequest): Promise<SearchResponse>;

  /**
   * Check health of all dependent services.
   *
   * @returns Health status of vector store, Postgres, and Ollama
   */
  checkHealth(): Promise<HealthResponse>;
}

// Placeholder constant for workspace resolution
export const RAG_VERSION = "0.1.0";

/** Maximum query length before truncation (in characters). */
const MAX_QUERY_LENGTH = 1000;

/** Ollama embed API response structure. */
interface OllamaEmbedResponse {
  embeddings?: number[][];
  error?: string;
}

/** Custom error for embedding failures that should return graceful response. */
class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly type: "NaN" | "timeout" | "unknown"
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/**
 * RAG pipeline orchestrator.
 *
 * Coordinates embedding, retrieval, context assembly, prompt building,
 * and LLM generation to answer queries about mutual fund documents.
 */
export class RAGPipeline implements IRAGPipeline {
  private readonly ollamaClient: OllamaClient;
  private readonly vectorClient: VectorClient;
  private readonly contextAssembler: ContextAssembler;
  private readonly promptBuilder: PromptBuilder;
  private readonly fundDetector: FundDetector;
  private readonly outputValidator: OutputValidator;
  private readonly embeddingConfig: EmbeddingConfig;
  private readonly retrievalConfig: RetrievalConfig;
  private readonly fundDetectionConfig: FundDetectionConfig;
  private readonly accessScope: TenantAccessScope;
  private fundDetectorInitialized = false;

  /**
   * Create a new RAGPipeline.
   *
   * @param config - Partial configuration (merged with defaults)
   */
  constructor(
    config: Partial<Omit<RAGPipelineConfig, "accessScope">>
      & Pick<RAGPipelineConfig, "accessScope">
      & { vector?: object },
  ) {
    // Merge with defaults
    const ollamaConfig = { ...DEFAULT_RAG_CONFIG.ollama, ...config.ollama };
    const embeddingConfig = {
      ...DEFAULT_EMBEDDING_CONFIG,
      ...config.embedding,
    };
    const retrievalConfig = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      ...config.retrieval,
    };
    const contextConfig = { ...DEFAULT_RAG_CONFIG.context, ...config.context };
    const fundDetectionConfig = {
      ...DEFAULT_FUND_DETECTION_CONFIG,
      ...config.fundDetection,
    };

    // Initialize components
    this.ollamaClient = new OllamaClient(ollamaConfig);
    this.vectorClient = new VectorClient(config.vector);
    this.contextAssembler = new ContextAssembler(contextConfig);
    this.promptBuilder = new PromptBuilder();
    this.fundDetector = new FundDetector(fundDetectionConfig);
    this.outputValidator = new OutputValidator();
    this.embeddingConfig = embeddingConfig;
    this.retrievalConfig = retrievalConfig;
    this.fundDetectionConfig = fundDetectionConfig;
    this.accessScope = config.accessScope;
  }

  /**
   * Initialize the fund detector with fund names from pgvector.
   * Called lazily on first query if not already initialized.
   */
  async initFundDetector(): Promise<void> {
    if (this.fundDetectorInitialized || !this.fundDetectionConfig.enabled) {
      return;
    }

    try {
      const fundNames = await this.vectorClient.getUniqueFundNames(this.accessScope);
      this.fundDetector.loadIndex(fundNames);
      this.fundDetectorInitialized = true;
    } catch (error) {
      // Log but don't fail - fund detection is optional
      console.warn("Failed to load fund names for auto-detection:", error);
    }
  }

  /**
   * Process a query and generate an answer with citations.
   *
   * @param request - Query request with question and optional filters
   * @returns Response with answer, citations, and metadata
   * @throws Error if query is empty
   * @throws Error if Ollama is unavailable
   */
  async query(request: QueryRequest): Promise<QueryResponse> {
    const startTime = Date.now();

    // Validate query
    if (!request.query || request.query.trim() === "") {
      throw new Error("Query cannot be empty");
    }

    // Truncate long queries
    const query = this.truncateQuery(request.query);
    const limit = request.limit ?? this.retrievalConfig.limit;

    // 0. Fund detection (if enabled and no filter already provided)
    let detectionResult: DetectionResult | undefined;
    let effectiveFilters = request.filters;

    if (this.fundDetectionConfig.enabled && !request.filters?.fundName) {
      // Initialize fund detector lazily
      await this.initFundDetector();

      if (this.fundDetector.isLoaded()) {
        detectionResult = this.fundDetector.detect(query);

        // Handle ambiguous queries (multiple funds mentioned)
        // If it's a comparison query, proceed without filter
        // If it's NOT a comparison query, return clarification
        if (detectionResult.ambiguous && !detectionResult.isComparisonQuery) {
          return this.buildClarificationResponse(
            startTime,
            detectionResult
          );
        }

        // Auto-apply suggested filter if high confidence and not ambiguous
        // Note: AMC filters are NOT auto-applied since they require knowing the full AMC name
        // and would return multiple funds anyway. AMC detection is informational only.
        if (detectionResult.suggestedFilter && !detectionResult.ambiguous) {
          effectiveFilters = {
            ...request.filters,
            ...detectionResult.suggestedFilter,
          };
        }
      }
    }

    // 1.5 Query rewriting: Remove detected fund name from query for better semantic search
    // When we filter by fund, we don't need the fund name in the embedding query
    // This helps focus the search on the actual question (e.g., "expense ratio")
    let embeddingQuery = query;
    if (detectionResult?.suggestedFilter?.fundName && !detectionResult.ambiguous) {
      embeddingQuery = this.removeFromQuery(query, detectionResult.suggestedFilter.fundName);
    }

    // 1. Embed query (use rewritten query if fund was detected)
    let queryVector: number[];
    try {
      queryVector = await this.embedQuery(embeddingQuery);
    } catch (error) {
      // Handle embedding errors gracefully
      if (error instanceof EmbeddingError) {
        return {
          answer: "I couldn't process your query. Please try rephrasing your question about mutual funds.",
          citations: [],
          metadata: {
            queryTimeMs: Date.now() - startTime,
            chunksRetrieved: 0,
            chunksUsed: 0,
            model: DEFAULT_RAG_CONFIG.ollama.model,
            validationFailed: true,
            validationReason: `Embedding error: ${error.type}`,
          },
        };
      }
      throw error; // Re-throw other errors
    }

    // 2. Search pgvector
    const searchFilters = this.mapQueryFilters(effectiveFilters);
    const vectorResults = await this.vectorClient.searchSimilar(queryVector, {
      accessScope: this.accessScope,
      limit,
      filters: searchFilters,
      scoreThreshold: this.retrievalConfig.scoreThreshold,
    });

    // 3. Assemble context
    const assembledContext = this.contextAssembler.assemble(vectorResults);

    // Build detection metadata
    const detectionMetadata = this.buildDetectionMetadata(
      detectionResult,
      effectiveFilters !== request.filters
    );

    // Handle no results case
    if (assembledContext.chunks.length === 0) {
      return {
        answer:
          "I don't have information to answer this question based on the available documents.",
        citations: [],
        metadata: {
          queryTimeMs: Date.now() - startTime,
          chunksRetrieved: 0,
          chunksUsed: 0,
          model: DEFAULT_RAG_CONFIG.ollama.model,
          ...detectionMetadata,
        },
      };
    }

    // 4. Build prompt
    const messages = this.promptBuilder.build(query, assembledContext);

    // 5. Generate response
    const llmResponse = await this.ollamaClient.generate(messages);

    // 6. Validate response (check for jailbreak/off-topic content)
    const validation = this.outputValidator.validate(
      llmResponse.content,
      assembledContext.formattedContext,
      query
    );

    // 7. Build citations
    const citations = this.buildCitations(assembledContext.chunks);

    // If validation failed, return rejection message
    if (!validation.valid) {
      return {
        answer: REJECTION_MESSAGE,
        citations: [], // Don't include citations for rejected responses
        metadata: {
          queryTimeMs: Date.now() - startTime,
          chunksRetrieved: vectorResults.length,
          chunksUsed: assembledContext.chunks.length,
          model: llmResponse.model,
          validationFailed: true,
          validationReason: validation.reason,
          ...detectionMetadata,
        },
      };
    }

    return {
      answer: llmResponse.content,
      citations,
      metadata: {
        queryTimeMs: Date.now() - startTime,
        chunksRetrieved: vectorResults.length,
        chunksUsed: assembledContext.chunks.length,
        model: llmResponse.model,
        ...detectionMetadata,
      },
    };
  }

  /**
   * Build clarification response when query matches multiple funds.
   */
  private buildClarificationResponse(
    startTime: number,
    detection: DetectionResult
  ): QueryResponse {
    const matchedFunds = detection.matches
      .filter((m) => m.confidence >= this.fundDetectionConfig.autoFilterThreshold)
      .slice(0, 5); // Limit to top 5 matches

    const fundList = matchedFunds
      .map((m, i) => `${i + 1}. ${m.fundName}`)
      .join("\n");

    const clarificationMessage = `I found multiple funds that might match your query:\n\n${fundList}\n\nPlease specify which fund you'd like information about, or ask a comparison question to compare them.`;

    const ambiguousMatches: DetectedFund[] = matchedFunds.map((m) => ({
      fundName: m.fundName,
      confidence: m.confidence,
      autoApplied: false,
    }));

    return {
      answer: clarificationMessage,
      citations: [],
      metadata: {
        queryTimeMs: Date.now() - startTime,
        chunksRetrieved: 0,
        chunksUsed: 0,
        model: DEFAULT_RAG_CONFIG.ollama.model,
        clarificationNeeded: true,
        ambiguousMatches,
        detectedAmc: detection.amcFilter,
      },
    };
  }

  /**
   * Build detection metadata for response.
   */
  private buildDetectionMetadata(
    detection: DetectionResult | undefined,
    filterApplied: boolean
  ): { detectedFund?: { fundName: string; confidence: number; autoApplied: boolean }; detectedAmc?: string } {
    if (!detection) {
      return {};
    }

    const result: { detectedFund?: { fundName: string; confidence: number; autoApplied: boolean }; detectedAmc?: string } = {};

    // Include top match if any
    if (detection.matches.length > 0 && !detection.ambiguous) {
      const topMatch = detection.matches[0];
      result.detectedFund = {
        fundName: topMatch.fundName,
        confidence: topMatch.confidence,
        autoApplied: filterApplied && detection.suggestedFilter !== undefined,
      };
    }

    // Include AMC filter if detected
    if (detection.amcFilter) {
      result.detectedAmc = detection.amcFilter;
    }

    return result;
  }

  /**
   * Search for relevant chunks without generating an answer.
   *
   * @param request - Search request with query and optional filters
   * @returns Search results with chunk text, scores, and metadata
   * @throws Error if query is empty
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    // Validate query
    if (!request.query || request.query.trim() === "") {
      throw new Error("Query cannot be empty");
    }

    const query = this.truncateQuery(request.query);
    const limit = request.limit ?? this.retrievalConfig.limit;

    // Embed query
    const queryVector = await this.embedQuery(query);

    // Search pgvector
    const searchFilters = this.mapQueryFilters(request.filters);
    const vectorResults = await this.vectorClient.searchSimilar(queryVector, {
      accessScope: this.accessScope,
      limit,
      filters: searchFilters,
      scoreThreshold: this.retrievalConfig.scoreThreshold,
    });

    // Transform results
    const results = vectorResults.map((r) => ({
      chunkId: r.id,
      text: r.payload.text,
      score: r.score,
      metadata: r.payload,
    }));

    return { results };
  }

  /**
   * Check health of all dependent services.
   *
   * @returns Health status of vector store, Postgres, and Ollama
   */
  async checkHealth(): Promise<HealthResponse> {
    const [vectorHealth, ollamaHealth] = await Promise.all([
      this.checkVectorHealth(),
      this.ollamaClient.checkHealth(),
    ]);

    // With pgvector, vector health IS postgres health
    const services = {
      vector: vectorHealth,
      postgres: vectorHealth,
      ollama: ollamaHealth,
    };

    // Determine overall status
    const healthyCount = Object.values(services).filter(Boolean).length;
    const totalCount = Object.values(services).length;

    let status: "ok" | "degraded" | "error";
    if (healthyCount === totalCount) {
      status = "ok";
    } else if (healthyCount === 0) {
      status = "error";
    } else {
      status = "degraded";
    }

    return { status, services };
  }

  /**
   * Embed a query using Ollama BGE-M3.
   *
   * @param query - Query text to embed
   * @returns Embedding vector
   * @throws Error if embedding fails
   */
  private async embedQuery(query: string): Promise<number[]> {
    const response = await fetch(
      `${this.embeddingConfig.baseUrl}/api/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.embeddingConfig.model,
          input: query,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");

      // Check for NaN error (embedding model instability)
      if (errorText.includes("NaN") || errorText.includes("unsupported value")) {
        throw new EmbeddingError(
          "Query caused embedding instability. Please rephrase your question.",
          "NaN"
        );
      }

      throw new Error(
        `Failed to embed query (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as OllamaEmbedResponse;

    if (data.error) {
      throw new Error(`Embedding error: ${data.error}`);
    }

    if (!data.embeddings || data.embeddings.length === 0) {
      throw new Error("Invalid embedding response: missing embeddings");
    }

    return data.embeddings[0];
  }

  /**
   * Check vector store health by attempting to access the chunks table.
   *
   * @returns true if vector store is healthy, false otherwise
   */
  private async checkVectorHealth(): Promise<boolean> {
    try {
      await this.vectorClient.collectionExists();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Truncate a query to the maximum length.
   *
   * @param query - Query to truncate
   * @returns Truncated query
   */
  private truncateQuery(query: string): string {
    if (query.length <= MAX_QUERY_LENGTH) {
      return query;
    }
    return query.slice(0, MAX_QUERY_LENGTH);
  }

  /**
   * Remove a detected entity (fund name) from query for better embedding.
   * This helps semantic search focus on the actual question.
   *
   * @param query - Original query
   * @param entity - Entity to remove (e.g., fund name)
   * @returns Query with entity removed
   */
  private removeFromQuery(query: string, entity: string): string {
    // Case-insensitive removal of the entity
    const pattern = new RegExp(
      entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi"
    );
    const cleaned = query
      .replace(pattern, "")
      .replace(/\s+/g, " ")
      .replace(/^\s*(?:of|for|about|in|the)\s+/i, "") // Remove orphaned prepositions at start
      .replace(/\s+(?:of|for|about|in|the)\s*$/i, "") // Remove orphaned prepositions at end
      .trim();

    // If we removed too much, return original
    if (cleaned.length < 5) {
      return query;
    }

    return cleaned;
  }

  /**
   * Map QueryFilters to SearchFilters (camelCase to snake_case).
   *
   * @param filters - Query filters (camelCase)
   * @returns Search filters (snake_case)
   */
  private mapQueryFilters(filters?: QueryFilters): SearchFilters | undefined {
    if (!filters) {
      return undefined;
    }

    const searchFilters: SearchFilters = {};

    if (filters.fundName) searchFilters.fund_name = filters.fundName;
    if (filters.amcName) searchFilters.amc_name = filters.amcName;
    if (filters.schemeType) searchFilters.scheme_type = filters.schemeType;
    if (filters.docType) searchFilters.doc_type = filters.docType;
    if (filters.dateFrom) searchFilters.date_from = filters.dateFrom;
    if (filters.dateTo) searchFilters.date_to = filters.dateTo;

    return Object.keys(searchFilters).length > 0 ? searchFilters : undefined;
  }

  /**
   * Build citations from assembled context chunks.
   *
   * @param chunks - Assembled context chunks
   * @returns Array of citations
   */
  private buildCitations(
    chunks: Array<{
      id: string;
      text: string;
      score: number;
      metadata: SearchResult["payload"];
      relevanceRank: number;
    }>
  ): Citation[] {
    return chunks.map((chunk) => ({
      index: chunk.relevanceRank,
      documentId: chunk.metadata.document_id,
      documentFilename: chunk.metadata.document_filename,
      fundName: chunk.metadata.fund_name,
      docType: chunk.metadata.doc_type,
      pageNumbers: chunk.metadata.page_numbers,
      textSnippet: chunk.text.slice(0, 200),
      relevanceScore: chunk.score,
      sebiUrl: chunk.metadata.sebi_url || undefined,
    }));
  }
}
