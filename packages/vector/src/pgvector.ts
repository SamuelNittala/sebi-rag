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
import { chunks, htmlChunks, VECTOR_DIMENSIONS } from "@mf-rag/db/schema";
import { eq, count, sql } from "drizzle-orm";
import type { ChunkPayload, HtmlChunkPayload } from "@mf-rag/types";
import type {
  SearchFilters,
  SearchResult,
  CollectionInfo,
  ChunkWithVector,
  HtmlSearchFilters,
  HtmlSearchResult,
  HtmlChunkWithVector,
  TenantAccessScope,
} from "./schema.ts";
import { tokenizeBm25Query } from "./bm25.ts";

function parseJsonObject<T>(value: T | string | null): T | null {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as T;
}

function postgresTextArray(tokens: string[]): string {
  return `{${tokens.join(",")}}`;
}

function tenantAccessCondition(accessScope: TenantAccessScope) {
  if (!accessScope?.tenantId) {
    throw new Error("Tenant access scope is required");
  }
  return sql`AND (
    visibility_scope = 'GLOBAL'
    OR (visibility_scope = 'TENANT' AND tenant_id = ${accessScope.tenantId})
  )`;
}

/** content_category filter supporting a single category or an allowed set. */
function htmlCategoryCondition(category: string | string[]) {
  const values = Array.isArray(category) ? category : [category];
  return sql`AND content_category IN (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

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
        documentKind: chunk.payload.document_kind ?? "scheme",
        documentTitle: chunk.payload.document_title ?? null,
        publisher: chunk.payload.publisher ?? null,
        sourceUrl: chunk.payload.source_url ?? null,
        sourceDate: chunk.payload.source_date ?? null,
        authority: chunk.payload.authority ?? null,
        topic: chunk.payload.topic ?? null,
        questionNumber: chunk.payload.question_number ?? null,
        normalizedQuestionKey: chunk.payload.normalized_question_key ?? null,
        originalQuestion: chunk.payload.original_question ?? null,
        continuationIndex: chunk.payload.continuation_index ?? null,
        knowledgeDomain: chunk.payload.knowledge_domain ?? "mutual_fund",
        sourceCollection: chunk.payload.source_collection ?? "default_corpus",
        amcSlug: chunk.payload.amc_slug ?? null,
        ingestionRunId: chunk.payload.ingestion_run_id ?? null,
        publicationStatus: chunk.payload.publication_status ?? "published",
        retrievalMetadata: chunk.payload.retrieval_metadata ?? null,
        visibilityScope: chunk.payload.visibility_scope ?? "UNCLASSIFIED",
        tenantId: chunk.payload.tenant_id ?? null,
        ownershipManifestId: chunk.payload.ownership_manifest_id ?? null,
        ownershipManifestVersion: chunk.payload.ownership_manifest_version ?? null,
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
          documentKind: sql`EXCLUDED.document_kind`,
          documentTitle: sql`EXCLUDED.document_title`,
          publisher: sql`EXCLUDED.publisher`,
          sourceUrl: sql`EXCLUDED.source_url`,
          sourceDate: sql`EXCLUDED.source_date`,
          authority: sql`EXCLUDED.authority`,
          topic: sql`EXCLUDED.topic`,
          questionNumber: sql`EXCLUDED.question_number`,
          normalizedQuestionKey: sql`EXCLUDED.normalized_question_key`,
          originalQuestion: sql`EXCLUDED.original_question`,
          continuationIndex: sql`EXCLUDED.continuation_index`,
          knowledgeDomain: sql`EXCLUDED.knowledge_domain`,
          sourceCollection: sql`EXCLUDED.source_collection`,
          amcSlug: sql`EXCLUDED.amc_slug`,
          ingestionRunId: sql`EXCLUDED.ingestion_run_id`,
          publicationStatus: sql`EXCLUDED.publication_status`,
          retrievalMetadata: sql`EXCLUDED.retrieval_metadata`,
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
      accessScope: TenantAccessScope;
      limit?: number;
      filters?: SearchFilters;
      scoreThreshold?: number;
    },
  ): Promise<SearchResult[]> {
    const { accessScope, limit = 10, filters, scoreThreshold } = options;

    // Build the vector string for pgvector
    const vectorStr = `[${queryVector.join(",")}]`;

    // Build WHERE conditions
    const conditions = this.buildConditions(filters);
    const accessCondition = tenantAccessCondition(accessScope);

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
      document_kind: ChunkPayload["document_kind"];
      document_title: string | null;
      publisher: string | null;
      source_url: string | null;
      source_date: string | null;
      authority: string | null;
      topic: string | null;
      question_number: string | null;
      normalized_question_key: string | null;
      original_question: string | null;
      continuation_index: number | null;
      knowledge_domain: string;
      source_collection: string;
      amc_slug: string | null;
      retrieval_metadata: ChunkPayload["retrieval_metadata"] | string | null;
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
        sebi_url,
        document_kind,
        document_title,
        publisher,
        source_url,
        source_date,
        authority,
        topic,
        question_number,
        normalized_question_key,
        original_question,
        continuation_index,
        knowledge_domain,
        source_collection,
        amc_slug,
        retrieval_metadata
      FROM chunks
      WHERE publication_status = 'published'
        ${accessCondition} ${conditions} ${thresholdClause}
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
        document_kind: row.document_kind ?? "scheme",
        document_title: row.document_title,
        publisher: row.publisher,
        source_url: row.source_url,
        source_date: row.source_date,
        authority: row.authority,
        topic: row.topic,
        question_number: row.question_number,
        normalized_question_key: row.normalized_question_key,
        original_question: row.original_question,
        continuation_index: row.continuation_index,
        knowledge_domain: row.knowledge_domain as ChunkPayload["knowledge_domain"],
        source_collection: row.source_collection as ChunkPayload["source_collection"],
        amc_slug: row.amc_slug,
        retrieval_metadata: parseJsonObject(row.retrieval_metadata),
      } as ChunkPayload,
    }));
  }

  async searchLexical(
    query: string,
    options: {
      accessScope: TenantAccessScope;
      limit?: number;
      filters?: SearchFilters;
    },
  ): Promise<SearchResult[]> {
    const tokens = tokenizeBm25Query(query);
    if (tokens.length === 0) return [];
    const { accessScope, limit = 40, filters } = options;
    const accessCondition = tenantAccessCondition(accessScope);
    const conditions = this.buildConditions(filters);
    const tokenArray = postgresTextArray(tokens);

    type ResultRow = {
      id: string;
      score: number;
      text: string;
      chunk_index: number;
      total_chunks: number;
      document_id: string;
      document_filename: string;
      page_numbers: number[] | string;
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
      document_kind: ChunkPayload["document_kind"];
      document_title: string | null;
      publisher: string | null;
      source_url: string | null;
      source_date: string | null;
      authority: string | null;
      topic: string | null;
      question_number: string | null;
      normalized_question_key: string | null;
      original_question: string | null;
      continuation_index: number | null;
      knowledge_domain: string;
      source_collection: string;
      amc_slug: string | null;
      retrieval_metadata: ChunkPayload["retrieval_metadata"] | string | null;
    };

    const results = (await db.execute(sql`
      WITH candidate_corpus AS (
        SELECT chunk_search_documents.search_tokens
        FROM chunks
        JOIN chunk_search_documents ON chunk_search_documents.chunk_id = chunks.id
        WHERE publication_status = 'published' ${accessCondition} ${conditions}
      ),
      corpus_stats AS (
        SELECT
          count(*)::double precision AS document_count,
          GREATEST(COALESCE(avg(cardinality(search_tokens)), 1), 1)::double precision
            AS average_document_length
        FROM candidate_corpus
      ),
      document_frequency AS MATERIALIZED (
        SELECT
          query_token,
          (
            SELECT count(*)::double precision
            FROM candidate_corpus
            WHERE search_tokens @> ARRAY[query_token]
          ) AS document_frequency
        FROM unnest(${tokenArray}::text[]) AS query_tokens(query_token)
      ),
      matched_documents AS (
        SELECT
          chunk_search_documents.chunk_id,
          chunk_search_documents.search_tokens,
          cardinality(chunk_search_documents.search_tokens)::double precision
            AS document_length
        FROM chunks
        JOIN chunk_search_documents ON chunk_search_documents.chunk_id = chunks.id
        WHERE publication_status = 'published' ${accessCondition} ${conditions}
          AND chunk_search_documents.search_tokens && ${tokenArray}::text[]
      ),
      document_terms AS (
        SELECT
          matched_documents.chunk_id,
          matched_documents.document_length,
          matched_term.query_token,
          count(*)::double precision AS term_frequency
        FROM matched_documents
        CROSS JOIN LATERAL unnest(matched_documents.search_tokens)
          AS matched_term(query_token)
        WHERE matched_term.query_token = ANY(${tokenArray}::text[])
        GROUP BY
          matched_documents.chunk_id,
          matched_documents.document_length,
          matched_term.query_token
      ),
      scored AS (
        SELECT
          document_terms.chunk_id,
          sum(
            ln(1 + (
              corpus_stats.document_count - document_frequency.document_frequency + 0.5
            ) / (document_frequency.document_frequency + 0.5))
            * (document_terms.term_frequency * 2.2)
            / (
              document_terms.term_frequency
              + 1.2 * (
                0.25 + 0.75 * document_terms.document_length
                  / corpus_stats.average_document_length
              )
            )
          )::double precision AS score
        FROM document_terms
        JOIN document_frequency USING (query_token)
        CROSS JOIN corpus_stats
        GROUP BY document_terms.chunk_id
        ORDER BY score DESC, document_terms.chunk_id
        LIMIT ${limit}
      )
      SELECT
        chunks.id,
        scored.score,
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
        sebi_url,
        document_kind,
        document_title,
        publisher,
        source_url,
        source_date,
        authority,
        topic,
        question_number,
        normalized_question_key,
        original_question,
        continuation_index,
        knowledge_domain,
        source_collection,
        amc_slug,
        retrieval_metadata
      FROM scored
      JOIN chunks ON chunks.id = scored.chunk_id
      ORDER BY scored.score DESC, chunks.id
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
        document_kind: row.document_kind ?? "scheme",
        document_title: row.document_title,
        publisher: row.publisher,
        source_url: row.source_url,
        source_date: row.source_date,
        authority: row.authority,
        topic: row.topic,
        question_number: row.question_number,
        normalized_question_key: row.normalized_question_key,
        original_question: row.original_question,
        continuation_index: row.continuation_index,
        knowledge_domain: row.knowledge_domain as ChunkPayload["knowledge_domain"],
        source_collection: row.source_collection as ChunkPayload["source_collection"],
        amc_slug: row.amc_slug,
        retrieval_metadata: parseJsonObject(row.retrieval_metadata),
      },
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
      parts.push(sql`AND regexp_replace(
        regexp_replace(lower(fund_name), '[^a-z0-9]+', '', 'g'),
        'fund$',
        ''
      ) LIKE '%' || regexp_replace(
        regexp_replace(lower(${filters.fund_name}), '[^a-z0-9]+', '', 'g'),
        'fund$',
        ''
      ) || '%'`);
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
    if (filters.knowledge_domain) {
      parts.push(sql`AND knowledge_domain = ${filters.knowledge_domain}`);
    }
    if (filters.source_collection) {
      parts.push(sql`AND source_collection = ${filters.source_collection}`);
    }
    if (filters.amc_slug) {
      parts.push(sql`AND amc_slug = ${filters.amc_slug}`);
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
  async getCollectionInfo(accessScope: TenantAccessScope): Promise<CollectionInfo> {
    const accessCondition = tenantAccessCondition(accessScope);
    const result = await db.execute(sql`
      SELECT count(*)::integer AS count
      FROM chunks
      WHERE publication_status = 'published' ${accessCondition}
    `) as Array<{ count: number }>;
    const totalCount = result[0]?.count ?? 0;

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
  async getUniqueFundNames(accessScope: TenantAccessScope): Promise<string[]> {
    const accessCondition = tenantAccessCondition(accessScope);
    const results = await db.execute(sql`
      SELECT DISTINCT fund_name
      FROM chunks
      WHERE publication_status = 'published'
        ${accessCondition}
        AND fund_name IS NOT NULL
        AND btrim(fund_name) <> ''
      ORDER BY fund_name
    `) as Array<{ fund_name: string }>;
    return results.map((row) => row.fund_name);
  }

  // ─── HTML Chunks ─────────────────────────────────────────────────────────

  async upsertHtmlChunks(chunksData: HtmlChunkWithVector[]): Promise<boolean> {
    if (chunksData.length === 0) {
      return true;
    }

    const BATCH_SIZE = 10;
    for (let i = 0; i < chunksData.length; i += BATCH_SIZE) {
      const batch = chunksData.slice(i, i + BATCH_SIZE);

      const values = batch.map((chunk) => ({
        id: chunk.id,
        embedding: chunk.vector,
        text: chunk.payload.text.replace(/\x00/g, ""),
        chunkIndex: chunk.payload.chunk_index,
        totalChunks: chunk.payload.total_chunks,
        documentId: chunk.payload.document_id,
        documentTitle: chunk.payload.document_title,
        sourceUrl: chunk.payload.source_url,
        contentCategory: chunk.payload.content_category,
        knowledgeDomain: chunk.payload.knowledge_domain ?? "mutual_fund",
        sourceCollection: chunk.payload.source_collection ?? "default_corpus",
        amcSlug: chunk.payload.amc_slug ?? null,
        ingestionRunId: chunk.payload.ingestion_run_id ?? null,
        publicationStatus: chunk.payload.publication_status ?? "published",
        retrievalMetadata: chunk.payload.retrieval_metadata ?? null,
        visibilityScope: chunk.payload.visibility_scope ?? "UNCLASSIFIED",
        tenantId: chunk.payload.tenant_id ?? null,
        ownershipManifestId: chunk.payload.ownership_manifest_id ?? null,
        ownershipManifestVersion: chunk.payload.ownership_manifest_version ?? null,
        sectionHeading: chunk.payload.section_heading,
        hasTable: chunk.payload.has_table,
      }));

      try {
        await db.insert(htmlChunks).values(values).onConflictDoUpdate({
          target: htmlChunks.id,
          set: {
            embedding: sql`EXCLUDED.embedding`,
            text: sql`EXCLUDED.text`,
            chunkIndex: sql`EXCLUDED.chunk_index`,
            totalChunks: sql`EXCLUDED.total_chunks`,
            documentTitle: sql`EXCLUDED.document_title`,
            sourceUrl: sql`EXCLUDED.source_url`,
            contentCategory: sql`EXCLUDED.content_category`,
            knowledgeDomain: sql`EXCLUDED.knowledge_domain`,
            sourceCollection: sql`EXCLUDED.source_collection`,
            amcSlug: sql`EXCLUDED.amc_slug`,
            sectionHeading: sql`EXCLUDED.section_heading`,
            hasTable: sql`EXCLUDED.has_table`,
            ingestionRunId: sql`EXCLUDED.ingestion_run_id`,
            publicationStatus: sql`EXCLUDED.publication_status`,
            retrievalMetadata: sql`EXCLUDED.retrieval_metadata`,
          },
        });
      } catch (error) {
        const pgError = error as any;
        console.error(`HTML batch insert failed at offset ${i}:`, pgError.cause?.message ?? pgError.message);
        throw error;
      }
    }

    return true;
  }

  async searchHtmlSimilar(
    queryVector: number[],
    options: {
      accessScope: TenantAccessScope;
      limit?: number;
      filters?: HtmlSearchFilters;
      scoreThreshold?: number;
    },
  ): Promise<HtmlSearchResult[]> {
    const { accessScope, limit = 10, filters, scoreThreshold } = options;
    const accessCondition = tenantAccessCondition(accessScope);

    const vectorStr = `[${queryVector.join(",")}]`;

    const conditions: ReturnType<typeof sql>[] = [];
    if (filters?.content_category) {
      conditions.push(htmlCategoryCondition(filters.content_category));
    }
    if (filters?.document_id) {
      conditions.push(sql`AND document_id = ${filters.document_id}::uuid`);
    }
    if (filters?.knowledge_domain) {
      conditions.push(sql`AND knowledge_domain = ${filters.knowledge_domain}`);
    }
    if (filters?.source_collection) {
      conditions.push(sql`AND source_collection = ${filters.source_collection}`);
    }
    if (filters?.amc_slug) {
      conditions.push(sql`AND amc_slug = ${filters.amc_slug}`);
    }

    const conditionsSql = conditions.length > 0 ? sql.join(conditions, sql` `) : sql``;

    const thresholdClause = scoreThreshold
      ? sql`AND (1 - (embedding <=> ${vectorStr}::vector)) >= ${scoreThreshold}`
      : sql``;

    type ResultRow = {
      id: string;
      score: number;
      text: string;
      chunk_index: number;
      total_chunks: number;
      document_id: string;
      document_title: string;
      source_url: string;
      content_category: string;
      section_heading: string | null;
      has_table: boolean;
      knowledge_domain: string;
      source_collection: string;
      amc_slug: string | null;
      retrieval_metadata: HtmlChunkPayload["retrieval_metadata"] | string | null;
    };

    const results = (await db.execute(sql`
      SELECT
        id,
        1 - (embedding <=> ${vectorStr}::vector) as score,
        text,
        chunk_index,
        total_chunks,
        document_id,
        document_title,
        source_url,
        content_category,
        section_heading,
        has_table,
        knowledge_domain,
        source_collection,
        amc_slug,
        retrieval_metadata
      FROM html_chunks
      WHERE publication_status = 'published'
        ${accessCondition} ${conditionsSql} ${thresholdClause}
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
        document_title: row.document_title,
        source_url: row.source_url,
        content_category: row.content_category as HtmlChunkPayload["content_category"],
        section_heading: row.section_heading,
        has_table: row.has_table,
        knowledge_domain: row.knowledge_domain as HtmlChunkPayload["knowledge_domain"],
        source_collection: row.source_collection as HtmlChunkPayload["source_collection"],
        amc_slug: row.amc_slug,
        retrieval_metadata: parseJsonObject(row.retrieval_metadata),
      },
    }));
  }

  async searchHtmlLexical(
    query: string,
    options: {
      accessScope: TenantAccessScope;
      limit?: number;
      filters?: HtmlSearchFilters;
    },
  ): Promise<HtmlSearchResult[]> {
    const tokens = tokenizeBm25Query(query);
    if (tokens.length === 0) return [];
    const { accessScope, limit = 40, filters } = options;
    const accessCondition = tenantAccessCondition(accessScope);
    const conditions = this.buildHtmlConditions(filters);
    const tokenArray = postgresTextArray(tokens);

    type ResultRow = {
      id: string;
      score: number;
      text: string;
      chunk_index: number;
      total_chunks: number;
      document_id: string;
      document_title: string;
      source_url: string;
      content_category: string;
      section_heading: string | null;
      has_table: boolean;
      knowledge_domain: string;
      source_collection: string;
      amc_slug: string | null;
      retrieval_metadata: HtmlChunkPayload["retrieval_metadata"] | string | null;
    };

    const results = (await db.execute(sql`
      WITH candidate_corpus AS (
        SELECT html_chunk_search_documents.search_tokens
        FROM html_chunks
        JOIN html_chunk_search_documents
          ON html_chunk_search_documents.chunk_id = html_chunks.id
        WHERE publication_status = 'published' ${accessCondition} ${conditions}
      ),
      corpus_stats AS (
        SELECT
          count(*)::double precision AS document_count,
          GREATEST(COALESCE(avg(cardinality(search_tokens)), 1), 1)::double precision
            AS average_document_length
        FROM candidate_corpus
      ),
      document_frequency AS MATERIALIZED (
        SELECT
          query_token,
          (
            SELECT count(*)::double precision
            FROM candidate_corpus
            WHERE search_tokens @> ARRAY[query_token]
          ) AS document_frequency
        FROM unnest(${tokenArray}::text[]) AS query_tokens(query_token)
      ),
      matched_documents AS (
        SELECT
          html_chunk_search_documents.chunk_id,
          html_chunk_search_documents.search_tokens,
          cardinality(html_chunk_search_documents.search_tokens)::double precision
            AS document_length
        FROM html_chunks
        JOIN html_chunk_search_documents
          ON html_chunk_search_documents.chunk_id = html_chunks.id
        WHERE publication_status = 'published' ${accessCondition} ${conditions}
          AND html_chunk_search_documents.search_tokens && ${tokenArray}::text[]
      ),
      document_terms AS (
        SELECT
          matched_documents.chunk_id,
          matched_documents.document_length,
          matched_term.query_token,
          count(*)::double precision AS term_frequency
        FROM matched_documents
        CROSS JOIN LATERAL unnest(matched_documents.search_tokens)
          AS matched_term(query_token)
        WHERE matched_term.query_token = ANY(${tokenArray}::text[])
        GROUP BY
          matched_documents.chunk_id,
          matched_documents.document_length,
          matched_term.query_token
      ),
      scored AS (
        SELECT
          document_terms.chunk_id,
          sum(
            ln(1 + (
              corpus_stats.document_count - document_frequency.document_frequency + 0.5
            ) / (document_frequency.document_frequency + 0.5))
            * (document_terms.term_frequency * 2.2)
            / (
              document_terms.term_frequency
              + 1.2 * (
                0.25 + 0.75 * document_terms.document_length
                  / corpus_stats.average_document_length
              )
            )
          )::double precision AS score
        FROM document_terms
        JOIN document_frequency USING (query_token)
        CROSS JOIN corpus_stats
        GROUP BY document_terms.chunk_id
        ORDER BY score DESC, document_terms.chunk_id
        LIMIT ${limit}
      )
      SELECT
        html_chunks.id,
        scored.score,
        text,
        chunk_index,
        total_chunks,
        document_id,
        document_title,
        source_url,
        content_category,
        section_heading,
        has_table,
        knowledge_domain,
        source_collection,
        amc_slug,
        retrieval_metadata
      FROM scored
      JOIN html_chunks ON html_chunks.id = scored.chunk_id
      ORDER BY scored.score DESC, html_chunks.id
    `)) as ResultRow[];

    return results.map((row) => ({
      id: row.id,
      score: row.score,
      payload: {
        text: row.text,
        chunk_index: row.chunk_index,
        total_chunks: row.total_chunks,
        document_id: row.document_id,
        document_title: row.document_title,
        source_url: row.source_url,
        content_category: row.content_category as HtmlChunkPayload["content_category"],
        section_heading: row.section_heading,
        has_table: row.has_table,
        knowledge_domain: row.knowledge_domain as HtmlChunkPayload["knowledge_domain"],
        source_collection: row.source_collection as HtmlChunkPayload["source_collection"],
        amc_slug: row.amc_slug,
        retrieval_metadata: parseJsonObject(row.retrieval_metadata),
      },
    }));
  }

  private buildHtmlConditions(filters?: HtmlSearchFilters) {
    if (!filters) return sql``;
    const conditions: ReturnType<typeof sql>[] = [];
    if (filters.content_category) {
      conditions.push(htmlCategoryCondition(filters.content_category));
    }
    if (filters.document_id) {
      conditions.push(sql`AND document_id = ${filters.document_id}::uuid`);
    }
    if (filters.knowledge_domain) {
      conditions.push(sql`AND knowledge_domain = ${filters.knowledge_domain}`);
    }
    if (filters.source_collection) {
      conditions.push(sql`AND source_collection = ${filters.source_collection}`);
    }
    if (filters.amc_slug) {
      conditions.push(sql`AND amc_slug = ${filters.amc_slug}`);
    }
    return conditions.length > 0 ? sql.join(conditions, sql` `) : sql``;
  }

  async deleteHtmlByDocumentId(documentId: string): Promise<number> {
    const countResult = await db
      .select({ count: count() })
      .from(htmlChunks)
      .where(eq(htmlChunks.documentId, documentId));

    const chunkCount = countResult[0]?.count ?? 0;

    if (chunkCount === 0) {
      return 0;
    }

    await db.delete(htmlChunks).where(eq(htmlChunks.documentId, documentId));

    return chunkCount;
  }

  async getHtmlCollectionInfo(accessScope: TenantAccessScope): Promise<CollectionInfo> {
    const accessCondition = tenantAccessCondition(accessScope);
    const result = await db.execute(sql`
      SELECT count(*)::integer AS count
      FROM html_chunks
      WHERE publication_status = 'published' ${accessCondition}
    `) as Array<{ count: number }>;
    const totalCount = result[0]?.count ?? 0;

    return {
      name: "html_chunks",
      vectors_count: totalCount,
      indexed_vectors_count: totalCount,
      points_count: totalCount,
      status: "green",
    };
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
    accessScope: TenantAccessScope;
    limit?: number;
    filters?: SearchFilters;
    scoreThreshold?: number;
  }
): Promise<SearchResult[]> {
  const client = new VectorClient();
  if (!options) throw new Error("Tenant access scope is required");
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
  _config: VectorClientConfig | undefined,
  accessScope: TenantAccessScope,
): Promise<CollectionInfo> {
  const client = new VectorClient();
  return client.getCollectionInfo(accessScope);
}

export { VECTOR_DIMENSIONS };
