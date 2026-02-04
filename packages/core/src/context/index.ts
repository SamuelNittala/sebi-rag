/**
 * Context assembly module for RAG pipeline.
 *
 * Responsible for:
 * - Transforming search results into RetrievedChunks
 * - Deduplicating near-identical chunks
 * - Token budgeting to fit context window
 * - Formatting context for prompt insertion
 */

import type { ChunkPayload } from "@mf-rag/types";

// Export types
export * from "./types.ts";

import {
  type ContextConfig,
  type RetrievedChunk,
  type AssembledContext,
  DEFAULT_CONTEXT_CONFIG,
  estimateTokens,
} from "./types.ts";

/** Search result from vector search. */
export interface SearchResult {
  id: string;
  score: number;
  payload: ChunkPayload;
}

// ContextAssembler interface - to be implemented
export interface IContextAssembler {
  /**
   * Assemble retrieved chunks into context for LLM.
   *
   * @param chunks - Raw search results from vector search
   * @param maxTokens - Maximum tokens for assembled context
   * @returns Assembled context ready for prompt
   */
  assemble(chunks: SearchResult[], maxTokens?: number): AssembledContext;
}

// Placeholder constant for workspace resolution
export const CONTEXT_VERSION = "0.1.0";

/**
 * Assembles search results into context for LLM prompts.
 *
 * Handles:
 * - Sorting by relevance score
 * - Deduplicating near-identical chunks from same document
 * - Token budgeting to fit context window
 * - Formatting with source citations
 */
export class ContextAssembler implements IContextAssembler {
  private readonly config: ContextConfig;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = {
      ...DEFAULT_CONTEXT_CONFIG,
      ...config,
    };
  }

  /**
   * Assemble retrieved chunks into context for LLM.
   */
  assemble(chunks: SearchResult[], maxTokens?: number): AssembledContext {
    const tokenLimit = maxTokens ?? this.config.maxTokens;

    if (chunks.length === 0) {
      return {
        chunks: [],
        totalTokens: 0,
        uniqueFunds: [],
        uniqueDocuments: [],
        formattedContext: "",
      };
    }

    // Sort by score descending
    const sorted = [...chunks].sort((a, b) => b.score - a.score);

    // Deduplicate near-identical chunks from same document
    const deduplicated = this.deduplicateChunks(sorted);

    // Transform to RetrievedChunks and apply token budget
    const result: RetrievedChunk[] = [];
    let totalTokens = 0;
    let rank = 1;

    for (const chunk of deduplicated) {
      const tokenEstimate = estimateTokens(chunk.payload.text);

      // Check if adding this chunk would exceed the limit
      if (totalTokens + tokenEstimate > tokenLimit) {
        continue;
      }

      result.push({
        id: chunk.id,
        text: chunk.payload.text,
        score: chunk.score,
        metadata: chunk.payload,
        tokenEstimate,
        relevanceRank: rank,
      });

      totalTokens += tokenEstimate;
      rank++;
    }

    // Collect unique funds and documents
    const uniqueFunds = [...new Set(result.map((c) => c.metadata.fund_name))];
    const uniqueDocuments = [...new Set(result.map((c) => c.metadata.document_id))];

    // Generate formatted context
    const formattedContext = this.formatContext(result);

    return {
      chunks: result,
      totalTokens,
      uniqueFunds,
      uniqueDocuments,
      formattedContext,
    };
  }

  /**
   * Deduplicate near-identical chunks from the same document.
   * Keeps the higher-scored chunk when duplicates are found.
   *
   * Deduplication criteria:
   * - Same fund name (same logical document source)
   * - Same document filename (same physical document)
   * - Same text content
   * - Overlapping page numbers (indicates same section)
   */
  private deduplicateChunks(chunks: SearchResult[]): SearchResult[] {
    const result: SearchResult[] = [];

    for (const chunk of chunks) {
      // Check if this chunk is a duplicate of any already-kept chunk
      const isDuplicate = result.some(
        (kept) =>
          kept.payload.fund_name === chunk.payload.fund_name &&
          kept.payload.document_filename === chunk.payload.document_filename &&
          kept.payload.text === chunk.payload.text &&
          this.hasOverlappingPages(kept.payload.page_numbers, chunk.payload.page_numbers)
      );

      if (!isDuplicate) {
        result.push(chunk);
      }
      // If duplicate, skip it (we keep the earlier one which has higher score since input is sorted)
    }

    return result;
  }

  /**
   * Check if two page number arrays overlap but are not identical.
   * Identical page arrays suggest different chunking of same pages,
   * while overlapping but different arrays suggest duplicate content
   * from the same source that got chunked into adjacent chunks.
   */
  private hasOverlappingPages(pages1: number[], pages2: number[]): boolean {
    // If pages are identical, don't consider it an overlap case
    // (they might be different chunks from the same page)
    if (
      pages1.length === pages2.length &&
      pages1.every((p, i) => p === pages2[i])
    ) {
      return false;
    }

    const set1 = new Set(pages1);
    return pages2.some((page) => set1.has(page));
  }

  /**
   * Format chunks into a context string with source citations.
   */
  private formatContext(chunks: RetrievedChunk[]): string {
    if (chunks.length === 0) {
      return "";
    }

    return chunks
      .map((chunk) => {
        const pages = chunk.metadata.page_numbers;
        const pageStr = pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages.join(", ")}`;
        const header = `[Source ${chunk.relevanceRank}] ${chunk.metadata.fund_name} (${chunk.metadata.doc_type}, ${pageStr})`;
        return `${header}\n${chunk.text}`;
      })
      .join("\n\n");
  }
}
