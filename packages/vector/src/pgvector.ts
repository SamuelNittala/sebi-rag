/**
 * pgvector client wrapper for MF PDF RAG system.
 *
 * Provides a typed interface for interacting with PostgreSQL + pgvector:
 * - Chunk upsert with vectors and payloads
 * - Semantic search with filters
 * - Document deletion
 * - Collection statistics
 */

import { db } from "@mf-rag/db/client";
import { chunks, VECTOR_DIMENSIONS } from "@mf-rag/db/schema";
import { eq, count, sql } from "drizzle-orm";
import type { ChunkPayload } from "@mf-rag/types";
import type {
  SearchFilters,
  SearchResult,
  CollectionInfo,
  ChunkWithVector,
} from "./schema.ts";

export interface VectorClientConfig {
  // These are kept for backwards compatibility but ignored
  // pgvector uses the shared DATABASE_URL connection
  url?: string;
  collectionName?: string;
  apiKey?: string;
}

/**
 * pgvector client wrapper with typed methods for the MF RAG system.
 */
export class VectorClient {
  constructor(_config?: VectorClientConfig) {
    // Uses shared database connection from @mf-rag/db
  }

  /**
   * Initialize the collection (no-op for pgvector, table created via migrations).
   * Kept for interface compatibility.
   *
   * @returns true if ready to use
   */
  async initCollection(): Promise<boolean> {
    // Table is created via Drizzle migrations
    // Just verify the table exists by running a simple query
    await db.select({ count: count() }).from(chunks).limit(1);
    return true;
  }

  /**
   * Insert or update chunks with their vectors.
   * Uses ON CONFLICT for upsert behavior.
   *
   * @param chunksData - Array of chunks with vectors and payloads
   * @returns true if upsert was successful
   */
  async upsertChunks(chunksData: ChunkWithVector[]): Promise<boolean> {
    if (chunksData.length === 0) {
      return true;
    }

    // Insert chunks in batches to avoid query size limits
    const BATCH_SIZE = 100;
    for (let i = 0; i < chunksData.length; i += BATCH_SIZE) {
      const batch = chunksData.slice(i, i + BATCH_SIZE);

      const values = batch.map((chunk) => ({
        id: chunk.id,
        embedding: chunk.vector,
        text: chunk.payload.text,
        chunkIndex: chunk.payload.chunk_index,
        totalChunks: chunk.payload.total_chunks,
        documentId: chunk.payload.document_id,
        documentFilename: chunk.payload.document_filename,
        pageNumbers: chunk.payload.page_numbers,
        fundName: chunk.payload.fund_name,
        amcName: chunk.payload.amc_name,
        schemeType: chunk.payload.scheme_type,
        schemeCategory: chunk.payload.scheme_category,
        docType: chunk.payload.doc_type,
        documentDate: chunk.payload.document_date,
        hasTable: chunk.payload.has_table,
        sectionHeader: chunk.payload.section_header,
        sebiSchemeId: chunk.payload.sebi_scheme_id,
        sebiUrl: chunk.payload.sebi_url,
      }));

      await db.insert(chunks).values(values).onConflictDoUpdate({
        target: chunks.id,
        set: {
          embedding: sql`EXCLUDED.embedding`,
          text: sql`EXCLUDED.text`,
          chunkIndex: sql`EXCLUDED.chunk_index`,
          totalChunks: sql`EXCLUDED.total_chunks`,
          documentFilename: sql`EXCLUDED.document_filename`,
          pageNumbers: sql`EXCLUDED.page_numbers`,
          fundName: sql`EXCLUDED.fund_name`,
          amcName: sql`EXCLUDED.amc_name`,
          schemeType: sql`EXCLUDED.scheme_type`,
          schemeCategory: sql`EXCLUDED.scheme_category`,
          docType: sql`EXCLUDED.doc_type`,
          documentDate: sql`EXCLUDED.document_date`,
          hasTable: sql`EXCLUDED.has_table`,
          sectionHeader: sql`EXCLUDED.section_header`,
          sebiSchemeId: sql`EXCLUDED.sebi_scheme_id`,
          sebiUrl: sql`EXCLUDED.sebi_url`,
        },
      });
    }

    return true;
  }

  /**
   * Search for similar chunks using vector similarity.
   * Supports filtering by various metadata fields.
   *
   * @param queryVector - Query embedding vector
   * @param options - Search options including limit and filters
   * @returns Array of search results sorted by similarity score
   */
  async searchSimilar(
    queryVector: number[],
    options: {
      limit?: number;
      filters?: SearchFilters;
      scoreThreshold?: number;
    } = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, filters, scoreThreshold } = options;

    // Build the vector string for pgvector
    const vectorStr = `[${queryVector.join(",")}]`;

    // Build WHERE conditions
    const conditions = this.buildConditions(filters);

    // Add score threshold condition if specified
    const thresholdClause = scoreThreshold
      ? sql`AND (1 - (embedding <=> ${vectorStr}::vector)) >= ${scoreThreshold}`
      : sql``;

    // Execute similarity search using cosine distance
    // Score is 1 - distance (so higher is more similar)
    type ResultRow = {
      id: string;
      score: number;
      text: string;
      chunk_index: number;
      total_chunks: number;
      document_id: string;
      document_filename: string;
      page_numbers: number[];
      fund_name: string;
      amc_name: string;
      scheme_type: string;
      scheme_category: string;
      doc_type: string;
      document_date: string;
      has_table: boolean;
      section_header: string | null;
      sebi_scheme_id: string;
      sebi_url: string;
    };

    const results = (await db.execute(sql`
      SELECT
        id,
        1 - (embedding <=> ${vectorStr}::vector) as score,
        text,
        chunk_index,
        total_chunks,
        document_id,
        document_filename,
        page_numbers,
        fund_name,
        amc_name,
        scheme_type,
        scheme_category,
        doc_type,
        document_date,
        has_table,
        section_header,
        sebi_scheme_id,
        sebi_url
      FROM chunks
      WHERE 1=1 ${conditions} ${thresholdClause}
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${limit}
    `)) as ResultRow[];

    return results.map((row) => ({
      id: row.id,
      score: row.score,
      payload: {
        text: row.text,
        chunk_index: row.chunk_index,
        total_chunks: row.total_chunks,
        document_id: row.document_id,
        document_filename: row.document_filename,
        // Parse JSONB - may be string from raw SQL or already parsed
        page_numbers: typeof row.page_numbers === "string"
          ? JSON.parse(row.page_numbers)
          : row.page_numbers,
        fund_name: row.fund_name,
        amc_name: row.amc_name,
        scheme_type: row.scheme_type,
        scheme_category: row.scheme_category,
        doc_type: row.doc_type,
        document_date: row.document_date,
        has_table: row.has_table,
        section_header: row.section_header,
        sebi_scheme_id: row.sebi_scheme_id,
        sebi_url: row.sebi_url,
      } as ChunkPayload,
    }));
  }

  /**
   * Build SQL conditions from search filters.
   */
  private buildConditions(filters?: SearchFilters) {
    if (!filters) {
      return sql``;
    }

    const parts: ReturnType<typeof sql>[] = [];

    if (filters.fund_name) {
      parts.push(sql`AND fund_name = ${filters.fund_name}`);
    }
    if (filters.amc_name) {
      parts.push(sql`AND amc_name = ${filters.amc_name}`);
    }
    if (filters.scheme_type) {
      parts.push(sql`AND scheme_type = ${filters.scheme_type}`);
    }
    if (filters.scheme_category) {
      parts.push(sql`AND scheme_category = ${filters.scheme_category}`);
    }
    if (filters.doc_type) {
      parts.push(sql`AND doc_type = ${filters.doc_type}`);
    }
    if (filters.document_id) {
      parts.push(sql`AND document_id = ${filters.document_id}::uuid`);
    }
    if (filters.date_from) {
      parts.push(sql`AND document_date >= ${filters.date_from}`);
    }
    if (filters.date_to) {
      parts.push(sql`AND document_date <= ${filters.date_to}`);
    }

    return sql.join(parts, sql` `);
  }

  /**
   * Delete all chunks for a specific document.
   *
   * @param documentId - Document ID to delete chunks for
   * @returns Number of chunks deleted
   */
  async deleteByDocumentId(documentId: string): Promise<number> {
    // Count chunks first
    const countResult = await db
      .select({ count: count() })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));

    const chunkCount = countResult[0]?.count ?? 0;

    if (chunkCount === 0) {
      return 0;
    }

    // Delete chunks
    await db.delete(chunks).where(eq(chunks.documentId, documentId));

    return chunkCount;
  }

  /**
   * Get collection statistics.
   *
   * @returns Collection information including point counts and status
   */
  async getCollectionInfo(): Promise<CollectionInfo> {
    const countResult = await db.select({ count: count() }).from(chunks);
    const totalCount = countResult[0]?.count ?? 0;

    return {
      name: "chunks",
      vectors_count: totalCount,
      indexed_vectors_count: totalCount,
      points_count: totalCount,
      status: "green",
    };
  }

  /**
   * Delete all chunks (truncate table).
   * Use with caution - this removes all data.
   */
  async deleteCollection(): Promise<boolean> {
    await db.delete(chunks);
    return true;
  }

  /**
   * Check if the chunks table has data.
   */
  async collectionExists(): Promise<boolean> {
    // Table always exists after migration, just check if it's accessible
    try {
      await db.select({ count: count() }).from(chunks).limit(1);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all unique fund names from the collection.
   *
   * @returns Array of unique fund names
   */
  async getUniqueFundNames(): Promise<string[]> {
    const results = await db
      .selectDistinct({ fundName: chunks.fundName })
      .from(chunks)
      .orderBy(chunks.fundName);

    return results.map((r) => r.fundName);
  }
}

// Standalone functions for convenience

/**
 * Initialize the collection (verify table exists).
 */
export async function initCollection(
  _config?: VectorClientConfig
): Promise<boolean> {
  const client = new VectorClient();
  return client.initCollection();
}

/**
 * Insert or update chunks with vectors.
 */
export async function upsertChunks(
  _config: VectorClientConfig | undefined,
  chunksData: ChunkWithVector[]
): Promise<boolean> {
  const client = new VectorClient();
  return client.upsertChunks(chunksData);
}

/**
 * Search for similar chunks.
 */
export async function searchSimilar(
  _config: VectorClientConfig | undefined,
  queryVector: number[],
  options?: {
    limit?: number;
    filters?: SearchFilters;
    scoreThreshold?: number;
  }
): Promise<SearchResult[]> {
  const client = new VectorClient();
  return client.searchSimilar(queryVector, options);
}

/**
 * Delete all chunks for a document.
 */
export async function deleteByDocumentId(
  _config: VectorClientConfig | undefined,
  documentId: string
): Promise<number> {
  const client = new VectorClient();
  return client.deleteByDocumentId(documentId);
}

/**
 * Get collection statistics.
 */
export async function getCollectionInfo(
  _config?: VectorClientConfig
): Promise<CollectionInfo> {
  const client = new VectorClient();
  return client.getCollectionInfo();
}

export { VECTOR_DIMENSIONS };
