import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  date,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  boolean,
  jsonb,
  real,
  customType,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  CandidateChunkMetadata,
  ChunkFlagSeverity,
  ChunkFlagStatus,
  ReviewRunStatus,
  ReviewPurpose,
  ReviewSourceType,
  VisibilityScope,
} from "@mf-rag/types";

// Custom type for pgvector
const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
  configRequired: true;
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // Parse "[0.1,0.2,...]" format
    return value
      .slice(1, -1)
      .split(",")
      .map((v) => parseFloat(v));
  },
});
const ownershipInvariant = sql.raw(`(
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
)`);

function ownershipColumns() {
  return {
    visibilityScope: varchar("visibility_scope", { length: 20 })
      .default("UNCLASSIFIED")
      .notNull()
      .$type<VisibilityScope>(),
    tenantId: varchar("tenant_id", { length: 100 }),
    ownershipManifestId: varchar("ownership_manifest_id", { length: 100 }),
    ownershipManifestVersion: integer("ownership_manifest_version"),
  };
}

// Document status enum values
export const documentStatuses = [
  "pending",
  "processing",
  "review_required",
  "completed",
  "failed",
] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

/**
 * Documents table - stores metadata about ingested PDF files
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    filename: varchar("filename", { length: 255 }).notNull(),
    filepath: varchar("filepath", { length: 500 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).unique().notNull(),
    docType: varchar("doc_type", { length: 50 }),
    documentDate: date("document_date", { mode: "date" }),
    documentKind: varchar("document_kind", { length: 50 }).default("scheme").notNull(),
    title: varchar("title", { length: 500 }),
    publisher: varchar("publisher", { length: 255 }),
    sourceUrl: varchar("source_url", { length: 1000 }),
    sourceDate: date("source_date", { mode: "date" }),
    authority: varchar("authority", { length: 100 }),
    pageCount: integer("page_count"),
    chunkCount: integer("chunk_count"),
    status: varchar("status", { length: 20 }).default("pending").notNull().$type<DocumentStatus>(),
    errorMessage: text("error_message"),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  () => [check("documents_ownership_invariant_ck", ownershipInvariant)],
);

/**
 * AMCs table - stores Asset Management Company metadata from SEBI
 */
export const amcs = pgTable(
  "amcs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sebiId: varchar("sebi_id", { length: 50 }).unique().notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("amcs_sebi_id_idx").on(table.sebiId)]
);

/**
 * Funds table - stores extracted metadata about mutual funds for filtering
 */
export const funds = pgTable(
  "funds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    amcName: varchar("amc_name", { length: 255 }),
    schemeType: varchar("scheme_type", { length: 50 }),
    schemeCategory: varchar("scheme_category", { length: 100 }),
    isinGrowth: varchar("isin_growth", { length: 20 }),
    isinDividend: varchar("isin_dividend", { length: 20 }),
    // SEBI identifiers for linking to scraper data
    sebiSchemeId: varchar("sebi_scheme_id", { length: 50 }).unique(),
    sebiFundId: varchar("sebi_fund_id", { length: 50 }),
    amcId: uuid("amc_id").references(() => amcs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("funds_sebi_scheme_id_idx").on(table.sebiSchemeId),
    index("funds_sebi_fund_id_idx").on(table.sebiFundId),
    index("funds_amc_id_idx").on(table.amcId),
  ]
);

/**
 * Junction table - links documents to funds (M:N relationship)
 * A document can mention multiple funds, a fund can appear in multiple documents
 */
export const documentFunds = pgTable(
  "document_funds",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.fundId] }),
  ]
);

/** BGE-M3 embedding dimensions */
export const VECTOR_DIMENSIONS = 1024;

/**
 * Chunks table - stores document chunks with vector embeddings (pgvector)
 */
export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Vector embedding (BGE-M3, 1024 dimensions)
    embedding: vector("embedding", { dimensions: VECTOR_DIMENSIONS }).notNull(),
    // Chunk content
    text: text("text").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    // Document reference
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    documentFilename: varchar("document_filename", { length: 255 }).notNull(),
    pageNumbers: jsonb("page_numbers").$type<number[]>().notNull(),
    // Fund metadata for filtering
    fundName: varchar("fund_name", { length: 255 }),
    amcName: varchar("amc_name", { length: 255 }),
    schemeType: varchar("scheme_type", { length: 50 }),
    schemeCategory: varchar("scheme_category", { length: 100 }),
    docType: varchar("doc_type", { length: 50 }).notNull(),
    documentDate: varchar("document_date", { length: 20 }),
    // Additional metadata
    hasTable: boolean("has_table").default(false).notNull(),
    sectionHeader: text("section_header"),
    sebiSchemeId: varchar("sebi_scheme_id", { length: 50 }),
    sebiUrl: varchar("sebi_url", { length: 500 }),
    documentKind: varchar("document_kind", { length: 50 }).default("scheme").notNull(),
    documentTitle: varchar("document_title", { length: 500 }),
    publisher: varchar("publisher", { length: 255 }),
    sourceUrl: varchar("source_url", { length: 1000 }),
    sourceDate: varchar("source_date", { length: 20 }),
    authority: varchar("authority", { length: 100 }),
    topic: text("topic"),
    questionNumber: varchar("question_number", { length: 50 }),
    normalizedQuestionKey: text("normalized_question_key"),
    originalQuestion: text("original_question"),
    continuationIndex: integer("continuation_index"),
    knowledgeDomain: varchar("knowledge_domain", { length: 50 })
      .default("mutual_fund")
      .notNull(),
    sourceCollection: varchar("source_collection", { length: 100 })
      .default("default_corpus")
      .notNull(),
    amcSlug: varchar("amc_slug", { length: 100 }),
    ingestionRunId: uuid("ingestion_run_id"),
    publicationStatus: varchar("publication_status", { length: 20 })
      .default("published")
      .notNull(),
    retrievalMetadata: jsonb("retrieval_metadata").$type<CandidateChunkMetadata>(),
    ...ownershipColumns(),
    // Timestamps
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    // Indexes for filtering
    index("chunks_document_id_idx").on(table.documentId),
    index("chunks_fund_name_idx").on(table.fundName),
    index("chunks_amc_name_idx").on(table.amcName),
    index("chunks_scheme_type_idx").on(table.schemeType),
    index("chunks_doc_type_idx").on(table.docType),
    index("chunks_sebi_scheme_id_idx").on(table.sebiSchemeId),
    index("chunks_knowledge_domain_idx").on(table.knowledgeDomain),
    index("chunks_source_collection_idx").on(table.sourceCollection),
    index("chunks_publication_status_idx").on(table.publicationStatus),
    index("chunks_normalized_question_idx").on(table.normalizedQuestionKey),
    index("chunks_generic_document_idx").on(
      table.documentKind,
      table.sourceUrl,
      table.publicationStatus,
    ),
    index("chunks_published_scope_tenant_idx").on(
      table.publicationStatus,
      table.visibilityScope,
      table.tenantId,
      table.knowledgeDomain,
      table.sourceCollection,
    ),
    // Unique constraint for idempotent upserts
    index("chunks_document_chunk_idx").on(table.documentId, table.chunkIndex),
    check("chunks_ownership_invariant_ck", ownershipInvariant),
  ]
);

// Relations for type-safe joins
export const documentsRelations = relations(documents, ({ many }) => ({
  documentFunds: many(documentFunds),
  chunks: many(chunks),
}));

export const chunksRelations = relations(chunks, ({ one }) => ({
  document: one(documents, {
    fields: [chunks.documentId],
    references: [documents.id],
  }),
}));

export const chunkSearchDocuments = pgTable(
  "chunk_search_documents",
  {
    chunkId: uuid("chunk_id")
      .primaryKey()
      .references(() => chunks.id, { onDelete: "cascade" }),
    searchTokens: text("search_tokens").array().notNull(),
  },
  (table) => [index("chunk_search_documents_tokens_idx").using("gin", table.searchTokens)],
);

export const amcsRelations = relations(amcs, ({ many }) => ({
  funds: many(funds),
}));

export const fundsRelations = relations(funds, ({ one, many }) => ({
  documentFunds: many(documentFunds),
  amc: one(amcs, {
    fields: [funds.amcId],
    references: [amcs.id],
  }),
}));

export const documentFundsRelations = relations(documentFunds, ({ one }) => ({
  document: one(documents, {
    fields: [documentFunds.documentId],
    references: [documents.id],
  }),
  fund: one(funds, {
    fields: [documentFunds.fundId],
    references: [funds.id],
  }),
}));

// ─── HTML Content Pipeline ───────────────────────────────────────────────────

/**
 * HTML Documents table - tracks scraped HTML pages and their ingestion status
 */
export const htmlDocuments = pgTable(
  "html_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 500 }).notNull(),
    sourceUrl: varchar("source_url", { length: 1000 }).unique().notNull(),
    sourceSlug: varchar("source_slug", { length: 255 }).notNull(),
    filePath: varchar("file_path", { length: 500 }).notNull(),
    fileHash: varchar("file_hash", { length: 64 }).unique().notNull(),
    contentCategory: varchar("content_category", { length: 50 }).notNull(),
    source: varchar("source", { length: 100 }).notNull(),
    knowledgeDomain: varchar("knowledge_domain", { length: 50 })
      .default("mutual_fund")
      .notNull(),
    sourceCollection: varchar("source_collection", { length: 100 })
      .default("default_corpus")
      .notNull(),
    amcSlug: varchar("amc_slug", { length: 100 }),
    chunkCount: integer("chunk_count"),
    status: varchar("status", { length: 20 }).default("pending").notNull().$type<DocumentStatus>(),
    errorMessage: text("error_message"),
    ...ownershipColumns(),
    scrapedAt: timestamp("scraped_at", { mode: "date" }).notNull(),
    ingestedAt: timestamp("ingested_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("html_documents_content_category_idx").on(table.contentCategory),
    index("html_documents_source_idx").on(table.source),
    index("html_documents_status_idx").on(table.status),
    check("html_documents_ownership_invariant_ck", ownershipInvariant),
  ]
);

/**
 * HTML Chunks table - stores embedded chunks from HTML content
 */
export const htmlChunks = pgTable(
  "html_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    embedding: vector("embedding", { dimensions: VECTOR_DIMENSIONS }).notNull(),
    text: text("text").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => htmlDocuments.id, { onDelete: "cascade" }),
    documentTitle: varchar("document_title", { length: 500 }).notNull(),
    sourceUrl: varchar("source_url", { length: 1000 }).notNull(),
    contentCategory: varchar("content_category", { length: 50 }).notNull(),
    knowledgeDomain: varchar("knowledge_domain", { length: 50 })
      .default("mutual_fund")
      .notNull(),
    sourceCollection: varchar("source_collection", { length: 100 })
      .default("default_corpus")
      .notNull(),
    amcSlug: varchar("amc_slug", { length: 100 }),
    sectionHeading: text("section_heading"),
    hasTable: boolean("has_table").default(false).notNull(),
    ingestionRunId: uuid("ingestion_run_id"),
    publicationStatus: varchar("publication_status", { length: 20 })
      .default("published")
      .notNull(),
    retrievalMetadata: jsonb("retrieval_metadata").$type<CandidateChunkMetadata>(),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("html_chunks_document_id_idx").on(table.documentId),
    index("html_chunks_content_category_idx").on(table.contentCategory),
    index("html_chunks_knowledge_domain_idx").on(table.knowledgeDomain),
    index("html_chunks_source_collection_idx").on(table.sourceCollection),
    index("html_chunks_publication_status_idx").on(table.publicationStatus),
    index("html_chunks_published_scope_tenant_idx").on(
      table.publicationStatus,
      table.visibilityScope,
      table.tenantId,
      table.knowledgeDomain,
      table.sourceCollection,
    ),
    index("html_chunks_document_chunk_idx").on(table.documentId, table.chunkIndex),
    check("html_chunks_ownership_invariant_ck", ownershipInvariant),
  ]
);

export const htmlDocumentsRelations = relations(htmlDocuments, ({ many }) => ({
  htmlChunks: many(htmlChunks),
}));

export const htmlChunksRelations = relations(htmlChunks, ({ one }) => ({
  document: one(htmlDocuments, {
    fields: [htmlChunks.documentId],
    references: [htmlDocuments.id],
  }),
}));

export const htmlChunkSearchDocuments = pgTable(
  "html_chunk_search_documents",
  {
    chunkId: uuid("chunk_id")
      .primaryKey()
      .references(() => htmlChunks.id, { onDelete: "cascade" }),
    searchTokens: text("search_tokens").array().notNull(),
  },
  (table) => [index("html_chunk_search_documents_tokens_idx").using("gin", table.searchTokens)],
);

// ─── Pre-embedding Chunk Review ─────────────────────────────────────────────

/**
 * One immutable parse/chunk/inspection attempt for a source document.
 * Candidate chunks remain outside the production vector tables until approval.
 */
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: varchar("source_type", { length: 20 }).notNull().$type<ReviewSourceType>(),
    reviewPurpose: varchar("review_purpose", { length: 20 })
      .default("content")
      .notNull()
      .$type<ReviewPurpose>(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceName: varchar("source_name", { length: 500 }).notNull(),
    sourceLocation: varchar("source_location", { length: 1000 }),
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    parserVersion: varchar("parser_version", { length: 50 }).notNull(),
    chunkerVersion: varchar("chunker_version", { length: 50 }).notNull(),
    inspectorVersion: varchar("inspector_version", { length: 50 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().$type<ReviewRunStatus>(),
    candidateChunkCount: integer("candidate_chunk_count").default(0).notNull(),
    inspectedChunkCount: integer("inspected_chunk_count").default(0).notNull(),
    flaggedChunkCount: integer("flagged_chunk_count").default(0).notNull(),
    criticalCount: integer("critical_count").default(0).notNull(),
    warningCount: integer("warning_count").default(0).notNull(),
    blockingCount: integer("blocking_count").default(0).notNull(),
    reviewer: varchar("reviewer", { length: 255 }),
    reviewNote: text("review_note"),
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("ingestion_runs_source_document_idx").on(table.sourceType, table.sourceDocumentId),
    index("ingestion_runs_status_idx").on(table.status),
    index("ingestion_runs_created_at_idx").on(table.createdAt),
    check("ingestion_runs_ownership_invariant_ck", ownershipInvariant),
  ],
);

/** Candidate text and metadata awaiting human approval and embedding. */
export const chunkCandidates = pgTable(
  "chunk_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    text: text("text").notNull(),
    pageNumbers: jsonb("page_numbers").$type<number[]>().notNull(),
    tokenCount: integer("token_count").notNull(),
    hasTable: boolean("has_table").default(false).notNull(),
    sectionHeader: text("section_header"),
    metadata: jsonb("metadata").$type<CandidateChunkMetadata>().notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("chunk_candidates_run_chunk_uidx").on(table.ingestionRunId, table.chunkIndex),
    index("chunk_candidates_run_idx").on(table.ingestionRunId),
    check("chunk_candidates_ownership_invariant_ck", ownershipInvariant),
  ],
);

/** Versioned, explainable findings produced by the deterministic inspector. */
export const chunkFlags = pgTable(
  "chunk_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    chunkCandidateId: uuid("chunk_candidate_id")
      .references(() => chunkCandidates.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index"),
    ruleCode: varchar("rule_code", { length: 100 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull().$type<ChunkFlagSeverity>(),
    blocksApproval: boolean("blocks_approval").default(false).notNull(),
    message: text("message").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
    status: varchar("status", { length: 20 }).default("open").notNull().$type<ChunkFlagStatus>(),
    reviewer: varchar("reviewer", { length: 255 }),
    reviewerNote: text("reviewer_note"),
    reviewedAt: timestamp("reviewed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("chunk_flags_run_idx").on(table.ingestionRunId),
    index("chunk_flags_candidate_idx").on(table.chunkCandidateId),
    index("chunk_flags_status_idx").on(table.status),
    index("chunk_flags_severity_idx").on(table.severity),
  ],
);

/** Append-only before/after history for reviewer-authored candidate text edits. */
export const chunkCandidateEdits = pgTable(
  "chunk_candidate_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    chunkCandidateId: uuid("chunk_candidate_id")
      .notNull()
      .references(() => chunkCandidates.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    beforeText: text("before_text").notNull(),
    afterText: text("after_text").notNull(),
    beforeContentHash: varchar("before_content_hash", { length: 64 }).notNull(),
    afterContentHash: varchar("after_content_hash", { length: 64 }).notNull(),
    editor: varchar("editor", { length: 255 }).notNull(),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("chunk_candidate_edits_run_idx").on(table.ingestionRunId, table.createdAt),
    index("chunk_candidate_edits_candidate_idx").on(table.chunkCandidateId, table.createdAt),
  ],
);

/** Append-only reviewer and workflow audit history. */
export const reviewEvents = pgTable(
  "review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    chunkFlagId: uuid("chunk_flag_id").references(() => chunkFlags.id, { onDelete: "set null" }),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    actor: varchar("actor", { length: 255 }).notNull(),
    note: text("note"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("review_events_run_idx").on(table.ingestionRunId, table.createdAt)],
);

export const ingestionRunsRelations = relations(ingestionRuns, ({ many }) => ({
  candidates: many(chunkCandidates),
  flags: many(chunkFlags),
  edits: many(chunkCandidateEdits),
  events: many(reviewEvents),
}));

export const chunkCandidatesRelations = relations(chunkCandidates, ({ one, many }) => ({
  ingestionRun: one(ingestionRuns, {
    fields: [chunkCandidates.ingestionRunId],
    references: [ingestionRuns.id],
  }),
  flags: many(chunkFlags),
  edits: many(chunkCandidateEdits),
}));

export const chunkCandidateEditsRelations = relations(chunkCandidateEdits, ({ one }) => ({
  ingestionRun: one(ingestionRuns, {
    fields: [chunkCandidateEdits.ingestionRunId],
    references: [ingestionRuns.id],
  }),
  candidate: one(chunkCandidates, {
    fields: [chunkCandidateEdits.chunkCandidateId],
    references: [chunkCandidates.id],
  }),
}));

export const chunkFlagsRelations = relations(chunkFlags, ({ one }) => ({
  ingestionRun: one(ingestionRuns, {
    fields: [chunkFlags.ingestionRunId],
    references: [ingestionRuns.id],
  }),
  candidate: one(chunkCandidates, {
    fields: [chunkFlags.chunkCandidateId],
    references: [chunkCandidates.id],
  }),
}));

/**
 * API Keys table - stores API keys for rate limiting
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyFingerprint: varchar("key_fingerprint", { length: 64 })
      .notNull()
      .unique(),
    tier: varchar("tier", { length: 20 }).default("free").notNull(),
    name: varchar("name", { length: 100 }),
    email: varchar("email", { length: 255 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("api_keys_is_active_idx").on(table.isActive),
  ]
);

export const apiKeyTenantScopes = pgTable(
  "api_key_tenant_scopes",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tenantId: varchar("tenant_id", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.apiKeyId, table.tenantId] }),
    index("api_key_tenant_scopes_tenant_idx").on(table.tenantId),
  ],
);

export const tenantOwnershipManifestApplications = pgTable(
  "tenant_ownership_manifest_applications",
  {
    manifestId: varchar("manifest_id", { length: 100 }).notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    manifestChecksum: varchar("manifest_checksum", { length: 64 }).notNull(),
    inventoryChecksum: varchar("inventory_checksum", { length: 64 }).notNull(),
    approvedBy: varchar("approved_by", { length: 255 }).notNull(),
    approvedAt: timestamp("approved_at", { mode: "date" }).notNull(),
    appliedAt: timestamp("applied_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.manifestId, table.manifestVersion] }),
    uniqueIndex("tenant_ownership_manifest_checksum_uidx").on(table.manifestChecksum),
    check("tenant_ownership_manifest_version_ck", sql`${table.manifestVersion} > 0`),
  ],
);

/**
 * Usage Records table - tracks API usage for rate limiting
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    toolName: varchar("tool_name", { length: 50 }).notNull(),
    queryHash: varchar("query_hash", { length: 64 }),
    responseTimeMs: integer("response_time_ms"),
    chunksRetrieved: integer("chunks_retrieved"),
    correlationId: varchar("correlation_id", { length: 100 }),
    tenantId: varchar("tenant_id", { length: 100 }),
    operation: varchar("operation", { length: 100 }),
    decision: varchar("decision", { length: 20 }),
    reasonCode: varchar("reason_code", { length: 100 }),
    resultCount: integer("result_count"),
    timestamp: timestamp("timestamp", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_records_api_key_id_idx").on(table.apiKeyId),
    index("usage_records_timestamp_idx").on(table.timestamp),
    index("usage_records_api_key_timestamp_idx").on(table.apiKeyId, table.timestamp),
  ]
);

// Relations for API keys and usage
export const apiKeysRelations = relations(apiKeys, ({ many }) => ({
  usageRecords: many(usageRecords),
  tenantScopes: many(apiKeyTenantScopes),
}));

export const apiKeyTenantScopesRelations = relations(apiKeyTenantScopes, ({ one }) => ({
  apiKey: one(apiKeys, {
    fields: [apiKeyTenantScopes.apiKeyId],
    references: [apiKeys.id],
  }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  apiKey: one(apiKeys, {
    fields: [usageRecords.apiKeyId],
    references: [apiKeys.id],
  }),
}));

// Type exports for use in queries
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type AMC = typeof amcs.$inferSelect;
export type NewAMC = typeof amcs.$inferInsert;
export type Fund = typeof funds.$inferSelect;
export type NewFund = typeof funds.$inferInsert;
export type DocumentFund = typeof documentFunds.$inferSelect;
export type NewDocumentFund = typeof documentFunds.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ApiKeyTenantScope = typeof apiKeyTenantScopes.$inferSelect;
export type NewApiKeyTenantScope = typeof apiKeyTenantScopes.$inferInsert;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
export type HtmlDocument = typeof htmlDocuments.$inferSelect;
export type NewHtmlDocument = typeof htmlDocuments.$inferInsert;
export type HtmlChunk = typeof htmlChunks.$inferSelect;
export type NewHtmlChunk = typeof htmlChunks.$inferInsert;
export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type NewIngestionRun = typeof ingestionRuns.$inferInsert;
export type ChunkCandidate = typeof chunkCandidates.$inferSelect;
export type NewChunkCandidate = typeof chunkCandidates.$inferInsert;
export type ChunkCandidateEdit = typeof chunkCandidateEdits.$inferSelect;
export type NewChunkCandidateEdit = typeof chunkCandidateEdits.$inferInsert;
export type ChunkFlag = typeof chunkFlags.$inferSelect;
export type NewChunkFlag = typeof chunkFlags.$inferInsert;
export type ReviewEvent = typeof reviewEvents.$inferSelect;
export type NewReviewEvent = typeof reviewEvents.$inferInsert;
