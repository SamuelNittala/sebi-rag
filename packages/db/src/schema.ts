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
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type {
  AccessScopeClassification,
  CandidateChunkMetadata,
  ChunkFlagSeverity,
  ChunkFlagStatus,
  ReviewRunStatus,
  ReviewPurpose,
  ReviewSourceType,
  SourceDiscoveryConfig,
  DesiredSourceRegistry,
  SourceFetchConstraints,
  SourceReviewConfig,
  VisibilityScope,
  DocumentPipelineStage,
} from "@mf-rag/types";

type StoredDocumentRiskClassification = "low" | "elevated";
type StoredDocumentRiskRoute = "system_approve" | "human_review";
interface StoredDocumentRiskEvidence {
  readonly isFirstVersion: boolean;
  readonly candidateChunkCount: number;
  readonly inspectedChunkCount: number;
  readonly openBlockingCount: number;
  readonly openWarningCount: number;
  readonly extractionAnomaly: boolean;
  readonly ownershipDrift: boolean;
  readonly configRevisionDrift: boolean;
  readonly parserVersionDrift: boolean;
  readonly chunkerVersionDrift: boolean;
  readonly inspectorVersionDrift: boolean;
}

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
    /** Additive compatibility link for scheduled pipeline writes. Legacy rows remain null. */
    documentVersionId: uuid("document_version_id")
      .references((): AnyPgColumn => documentVersions.id, { onDelete: "set null" }),
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
    /** Additive compatibility link for scheduled pipeline writes. Legacy rows remain null. */
    documentVersionId: uuid("document_version_id")
      .references((): AnyPgColumn => documentVersions.id, { onDelete: "set null" }),
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
    /** Required by the scheduled pipeline; nullable for legacy/manual review runs. */
    documentVersionId: uuid("document_version_id")
      .references((): AnyPgColumn => documentVersions.id, { onDelete: "set null" }),
    pipelineRunId: uuid("pipeline_run_id")
      .references((): AnyPgColumn => pipelineRuns.id, { onDelete: "set null" }),
    configRevisionId: uuid("config_revision_id")
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    riskPolicyVersion: varchar("risk_policy_version", { length: 100 }),
    riskClassification: varchar("risk_classification", { length: 20 })
      .$type<StoredDocumentRiskClassification>(),
    riskRoute: varchar("risk_route", { length: 30 }).$type<StoredDocumentRiskRoute>(),
    riskReasonCodes: jsonb("risk_reason_codes").$type<string[]>(),
    riskEvidence: jsonb("risk_evidence").$type<StoredDocumentRiskEvidence>(),
    riskActor: varchar("risk_actor", { length: 255 }),
    riskDecidedAt: timestamp("risk_decided_at", { mode: "date", withTimezone: true }),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("ingestion_runs_source_document_idx").on(table.sourceType, table.sourceDocumentId),
    uniqueIndex("ingestion_runs_version_implementation_uidx")
      .on(
        table.documentVersionId,
        table.pipelineRunId,
        table.configRevisionId,
        table.parserVersion,
        table.chunkerVersion,
        table.inspectorVersion,
      )
      .where(sql`${table.documentVersionId} IS NOT NULL`),
    index("ingestion_runs_status_idx").on(table.status),
    index("ingestion_runs_pipeline_run_idx").on(table.pipelineRunId),
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

// ─── Document Source Control Plane ─────────────────────────────────────────

/** One immutable, checksummed desired-state snapshot. Exactly one is active. */
export const sourceRegistryRevisions = pgTable(
  "source_registry_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checksum: varchar("checksum", { length: 64 }).notNull(),
    desiredState: jsonb("desired_state").$type<DesiredSourceRegistry>().notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    appliedAt: timestamp("applied_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    supersededAt: timestamp("superseded_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("source_registry_revisions_checksum_uidx").on(table.checksum),
    uniqueIndex("source_registry_revisions_one_active_uidx")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
  ],
);

/** Stable retrieval boundary, independent from organization and knowledge domain. */
export const accessScopes = pgTable(
  "access_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessScopeKey: varchar("access_scope_key", { length: 100 }).notNull(),
    externalCode: varchar("external_code", { length: 100 }).notNull(),
    tenantId: varchar("tenant_id", { length: 100 }).notNull(),
    knowledgeDomain: varchar("knowledge_domain", { length: 50 })
      .notNull()
      .$type<AccessScopeClassification["knowledgeDomain"]>(),
    sourceCollection: varchar("source_collection", { length: 100 }).notNull(),
    amcSlug: varchar("amc_slug", { length: 100 }),
    enabled: boolean("enabled").default(true).notNull(),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    emergencyFrozenAt: timestamp("emergency_frozen_at", { mode: "date", withTimezone: true }),
    emergencyFreezeReason: text("emergency_freeze_reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("access_scopes_key_uidx").on(table.accessScopeKey),
    uniqueIndex("access_scopes_external_code_uidx").on(table.externalCode),
    check("access_scopes_external_code_ck", sql`${table.externalCode} ~ '^[0-9]{1,20}$'`),
    check("access_scopes_tenant_compat_ck", sql`${table.tenantId} = ${table.externalCode}`),
  ],
);

/** Stable source identity plus its currently reconciled desired configuration. */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceKey: varchar("source_key", { length: 100 }).notNull(),
    connector: varchar("connector", { length: 50 }).notNull(),
    discoveryConfig: jsonb("discovery_config").$type<SourceDiscoveryConfig>().notNull(),
    fetchConfig: jsonb("fetch_config").$type<SourceFetchConstraints>().notNull(),
    reviewConfig: jsonb("review_config").$type<SourceReviewConfig>().notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    emergencyFrozenAt: timestamp("emergency_frozen_at", { mode: "date", withTimezone: true }),
    emergencyFreezeReason: text("emergency_freeze_reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("sources_scope_key_uidx").on(table.accessScopeId, table.sourceKey),
    uniqueIndex("sources_id_scope_uidx").on(table.id, table.accessScopeId),
    index("sources_enabled_idx").on(table.enabled),
  ],
);

/** Desired cadence and the next wall-clock occurrence not yet claimed. */
export const sourceSchedules = pgTable(
  "source_schedules",
  {
    sourceId: uuid("source_id")
      .primaryKey()
      .references(() => sources.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").default(false).notNull(),
    cron: varchar("cron", { length: 100 }).notNull(),
    timezone: varchar("timezone", { length: 100 }).notNull(),
    nextDueAt: timestamp("next_due_at", { mode: "date", withTimezone: true }).notNull(),
    pausedAt: timestamp("paused_at", { mode: "date", withTimezone: true }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("source_schedules_due_idx").on(table.enabled, table.pausedAt, table.nextDueAt)],
);

export const discoveryRunStatuses = [
  "pending",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;
export type DiscoveryRunStatus = (typeof discoveryRunStatuses)[number];

export interface DiscoveryRetryHistoryEntry {
  readonly attempt: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly failedAt: string;
  readonly retryAt: string | null;
}

/** Append-only scheduling/discovery history; source removal never deletes these rows. */
export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    scheduledFor: timestamp("scheduled_for", { mode: "date", withTimezone: true }).notNull(),
    status: varchar("status", { length: 20 }).notNull().$type<DiscoveryRunStatus>(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    nextRetryAt: timestamp("next_retry_at", { mode: "date", withTimezone: true }),
    leaseOwner: varchar("lease_owner", { length: 255 }),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true }),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: text("error_message"),
    terminalDisposition: varchar("terminal_disposition", { length: 40 }),
    retryHistory: jsonb("retry_history").$type<DiscoveryRetryHistoryEntry[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("discovery_runs_source_scheduled_uidx").on(table.sourceId, table.scheduledFor),
    index("discovery_runs_source_created_idx").on(table.sourceId, table.createdAt),
    index("discovery_runs_status_idx").on(table.status),
    index("discovery_runs_claim_idx").on(table.status, table.nextRetryAt),
    index("discovery_runs_lease_idx").on(table.status, table.leaseExpiresAt),
    index("discovery_runs_active_source_idx")
      .on(table.sourceId)
      .where(sql`${table.status} IN ('pending', 'running', 'retry_wait')`),
    check("discovery_runs_status_ck", sql`${table.status} IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'cancelled')`),
    check("discovery_runs_attempts_ck", sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} > 0`),
    check("discovery_runs_lease_epoch_ck", sql`${table.leaseEpoch} >= 0`),
  ],
);

/** Immutable, content-addressed objects verified before their metadata is recorded. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactKey: varchar("artifact_key", { length: 1000 }).notNull(),
    uri: varchar("uri", { length: 2000 }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    mediaType: varchar("media_type", { length: 255 }).notNull(),
    producerVersion: varchar("producer_version", { length: 255 }).notNull(),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("artifacts_key_uidx").on(table.artifactKey),
    uniqueIndex("artifacts_uri_uidx").on(table.uri),
    index("artifacts_sha256_idx").on(table.sha256),
    check("artifacts_sha256_ck", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("artifacts_byte_size_ck", sql`${table.byteSize} >= 0`),
  ],
);

/** Stable identity for a document within one owning access scope and source. */
export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    logicalDocumentKey: varchar("logical_document_key", { length: 500 }).notNull(),
    canonicalUrl: varchar("canonical_url", { length: 2000 }).notNull(),
    currentVersionId: uuid("current_version_id")
      .references((): AnyPgColumn => documentVersions.id, { onDelete: "restrict" }),
    /** Set only by a complete successful discovery presence batch. */
    missingSince: timestamp("missing_since", { mode: "date", withTimezone: true }),
    missingEvidenceCount: integer("missing_evidence_count").default(0).notNull(),
    lastPresentAt: timestamp("last_present_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_documents_source_key_uidx").on(table.sourceId, table.logicalDocumentKey),
    uniqueIndex("source_documents_scope_url_uidx").on(table.accessScopeId, table.canonicalUrl),
    uniqueIndex("source_documents_id_source_scope_uidx").on(table.id, table.sourceId, table.accessScopeId),
    index("source_documents_current_version_idx").on(table.currentVersionId),
    index("source_documents_missing_idx").on(table.sourceId, table.missingSince),
    check("source_documents_missing_evidence_ck", sql`${table.missingEvidenceCount} >= 0`),
    foreignKey({
      name: "source_documents_source_scope_fk",
      columns: [table.sourceId, table.accessScopeId],
      foreignColumns: [sources.id, sources.accessScopeId],
    }).onDelete("restrict"),
  ],
);

/** Immutable bytes and fetch provenance for one owned logical document version. */
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "restrict" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    contentSha256: varchar("content_sha256", { length: 64 }).notNull(),
    rawArtifactId: uuid("raw_artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "restrict" }),
    /** Immutable desired-state lineage for scheduled acquisition; legacy imports remain null. */
    configRevisionId: uuid("config_revision_id")
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    etag: varchar("etag", { length: 1000 }),
    lastModified: varchar("last_modified", { length: 1000 }),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp("ready_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_versions_document_hash_uidx").on(table.sourceDocumentId, table.contentSha256),
    uniqueIndex("document_versions_document_sequence_uidx").on(table.sourceDocumentId, table.sequence),
    uniqueIndex("document_versions_id_source_scope_uidx").on(table.id, table.sourceId, table.accessScopeId),
    index("document_versions_scope_source_idx").on(table.accessScopeId, table.sourceId),
    index("document_versions_config_revision_idx").on(table.configRevisionId),
    check("document_versions_sequence_ck", sql`${table.sequence} > 0`),
    check("document_versions_sha256_ck", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: "document_versions_document_owner_fk",
      columns: [table.sourceDocumentId, table.sourceId, table.accessScopeId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.sourceId, sourceDocuments.accessScopeId],
    }).onDelete("restrict"),
  ],
);

/** Canonical and redirect aliases; one URL can have only one owner in an access scope. */
export const sourceDocumentUrlAliases = pgTable(
  "source_document_url_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "cascade" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    aliasUrl: varchar("alias_url", { length: 2000 }).notNull(),
    isCanonical: boolean("is_canonical").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("source_document_aliases_scope_url_uidx").on(table.accessScopeId, table.aliasUrl),
    index("source_document_aliases_document_idx").on(table.sourceDocumentId),
    foreignKey({
      name: "source_document_aliases_document_owner_fk",
      columns: [table.sourceDocumentId, table.sourceId, table.accessScopeId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.sourceId, sourceDocuments.accessScopeId],
    }).onDelete("cascade"),
  ],
);

/** Idempotent per-run presence/validator observation; unchanged fetches stop here. */
export const documentObservations = pgTable(
  "document_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discoveryRunId: uuid("discovery_run_id")
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: "restrict" }),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "restrict" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    observedUrl: varchar("observed_url", { length: 2000 }).notNull(),
    etag: varchar("etag", { length: 1000 }),
    lastModified: varchar("last_modified", { length: 1000 }),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_observations_run_document_uidx").on(table.discoveryRunId, table.sourceDocumentId),
    index("document_observations_source_observed_idx").on(table.sourceId, table.observedAt),
    foreignKey({
      name: "document_observations_document_owner_fk",
      columns: [table.sourceDocumentId, table.sourceId, table.accessScopeId],
      foreignColumns: [sourceDocuments.id, sourceDocuments.sourceId, sourceDocuments.accessScopeId],
    }).onDelete("restrict"),
  ],
);

export const pipelineRunStatuses = ["active", "succeeded", "failed", "cancelled"] as const;
export type PipelineRunStatus = (typeof pipelineRunStatuses)[number];

/** One version-owned workflow. Pause drains running work and blocks new claims. */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    implementationVersion: varchar("implementation_version", { length: 255 }).notNull(),
    /** Immutable registry snapshot used to derive ownership/classification for this run. */
    configRevisionId: uuid("config_revision_id")
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    initialStage: varchar("initial_stage", { length: 50 }).notNull().$type<DocumentPipelineStage>(),
    initialStageImplementationVersion: varchar("initial_stage_implementation_version", { length: 255 }).notNull(),
    initialInputChecksum: varchar("initial_input_checksum", { length: 64 }).notNull(),
    initialMaxAttempts: integer("initial_max_attempts").notNull(),
    status: varchar("status", { length: 20 }).default("active").notNull().$type<PipelineRunStatus>(),
    pausedAt: timestamp("paused_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("pipeline_runs_version_implementation_uidx")
      .on(table.documentVersionId, table.implementationVersion),
    uniqueIndex("pipeline_runs_id_version_source_scope_uidx")
      .on(table.id, table.documentVersionId, table.sourceId, table.accessScopeId),
    index("pipeline_runs_scope_status_idx").on(table.accessScopeId, table.status),
    index("pipeline_runs_config_revision_idx").on(table.configRevisionId),
    check("pipeline_runs_status_ck", sql`${table.status} IN ('active', 'succeeded', 'failed', 'cancelled')`),
    check("pipeline_runs_initial_input_checksum_ck", sql`${table.initialInputChecksum} ~ '^[0-9a-f]{64}$'`),
    check("pipeline_runs_initial_max_attempts_ck", sql`${table.initialMaxAttempts} > 0`),
    foreignKey({
      name: "pipeline_runs_document_owner_fk",
      columns: [table.documentVersionId, table.sourceId, table.accessScopeId],
      foreignColumns: [documentVersions.id, documentVersions.sourceId, documentVersions.accessScopeId],
    }).onDelete("restrict"),
  ],
);

export const stageAttemptStatuses = [
  "pending",
  "running",
  "retry_wait",
  "succeeded",
  "failed",
  "dead_letter",
  "reused",
  "cancelled",
] as const;
export type StageAttemptStatus = (typeof stageAttemptStatuses)[number];

export const stageTerminalDispositions = [
  "SUCCEEDED",
  "RETRY_SCHEDULED",
  "DETERMINISTIC_FAILURE",
  "DEAD_LETTER",
  "REUSED_SUCCESS",
  "CANCELLED",
] as const;
export type StageTerminalDisposition = (typeof stageTerminalDispositions)[number];

/**
 * Immutable execution history for one compatible stage input. `is_current`
 * identifies the only claimable retry while prior attempts remain auditable.
 */
export const stageAttempts = pgTable(
  "stage_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    stage: varchar("stage", { length: 50 }).notNull().$type<DocumentPipelineStage>(),
    implementationVersion: varchar("implementation_version", { length: 255 }).notNull(),
    inputChecksum: varchar("input_checksum", { length: 64 }).notNull(),
    outputRef: varchar("output_ref", { length: 2000 }),
    outputChecksum: varchar("output_checksum", { length: 64 }),
    status: varchar("status", { length: 20 }).default("pending").notNull().$type<StageAttemptStatus>(),
    terminalDisposition: varchar("terminal_disposition", { length: 40 }).$type<StageTerminalDisposition>(),
    attemptNumber: integer("attempt_number").default(1).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    isCurrent: boolean("is_current").default(true).notNull(),
    nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    leaseOwner: varchar("lease_owner", { length: 255 }),
    leaseEpoch: integer("lease_epoch").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true }),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: text("error_message"),
    requeuedBy: varchar("requeued_by", { length: 255 }),
    requeuedFromAttemptId: uuid("requeued_from_attempt_id")
      .references((): AnyPgColumn => stageAttempts.id, { onDelete: "restrict" }),
    reusedAttemptId: uuid("reused_attempt_id")
      .references((): AnyPgColumn => stageAttempts.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("stage_attempts_one_current_compatible_uidx")
      .on(table.pipelineRunId, table.stage)
      .where(sql`${table.isCurrent} = true`),
    uniqueIndex("stage_attempts_one_success_compatible_uidx")
      .on(table.documentVersionId, table.stage, table.implementationVersion, table.inputChecksum)
      .where(sql`${table.status} = 'succeeded'`),
    index("stage_attempts_claim_due_idx").on(table.status, table.nextRunAt),
    index("stage_attempts_expired_lease_idx").on(table.status, table.leaseExpiresAt),
    index("stage_attempts_dead_letter_idx").on(table.status, table.completedAt),
    check("stage_attempts_status_ck", sql`${table.status} IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'reused', 'cancelled')`),
    check("stage_attempts_input_checksum_ck", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
    check("stage_attempts_output_checksum_ck", sql`${table.outputChecksum} IS NULL OR ${table.outputChecksum} ~ '^[0-9a-f]{64}$'`),
    check("stage_attempts_attempt_number_ck", sql`${table.attemptNumber} > 0 AND ${table.maxAttempts} > 0`),
    check("stage_attempts_lease_epoch_ck", sql`${table.leaseEpoch} >= 0`),
    foreignKey({
      name: "stage_attempts_pipeline_run_owner_fk",
      columns: [table.pipelineRunId, table.documentVersionId, table.sourceId, table.accessScopeId],
      foreignColumns: [pipelineRuns.id, pipelineRuns.documentVersionId, pipelineRuns.sourceId, pipelineRuns.accessScopeId],
    }).onDelete("restrict"),
  ],
);

export const documentPublicationStatuses = ["staged", "published", "retired", "stale"] as const;
export type DocumentPublicationStatus = (typeof documentPublicationStatuses)[number];

/**
 * Scheduled-path vector generation. It deliberately references the control-plane
 * document/version lineage and never fabricates a row in the legacy documents table.
 */
export const documentPublicationGenerations = pgTable(
  "document_publication_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocuments.id, { onDelete: "restrict" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    ingestionRunId: uuid("ingestion_run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "restrict" }),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "restrict" }),
    accessScopeId: uuid("access_scope_id")
      .notNull()
      .references(() => accessScopes.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    configRevisionId: uuid("config_revision_id")
      .notNull()
      .references(() => sourceRegistryRevisions.id, { onDelete: "restrict" }),
    riskPolicyVersion: varchar("risk_policy_version", { length: 100 }).notNull(),
    riskDecisionActor: varchar("risk_decision_actor", { length: 255 }).notNull(),
    parserVersion: varchar("parser_version", { length: 50 }).notNull(),
    chunkerVersion: varchar("chunker_version", { length: 50 }).notNull(),
    inspectorVersion: varchar("inspector_version", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 })
      .default("staged")
      .notNull()
      .$type<DocumentPublicationStatus>(),
    ...ownershipColumns(),
    stagedAt: timestamp("staged_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    retiredAt: timestamp("retired_at", { mode: "date", withTimezone: true }),
    staleAt: timestamp("stale_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    uniqueIndex("document_publication_generations_run_uidx").on(table.ingestionRunId),
    uniqueIndex("document_publication_generations_one_published_uidx")
      .on(table.sourceDocumentId)
      .where(sql`${table.status} = 'published'`),
    index("document_publication_generations_version_idx").on(table.documentVersionId),
    check("document_publication_generations_status_ck", sql`${table.status} IN ('staged', 'published', 'retired', 'stale')`),
    check("document_publication_generations_ownership_ck", ownershipInvariant),
    foreignKey({
      name: "document_publication_generation_owner_fk",
      columns: [table.documentVersionId, table.sourceId, table.accessScopeId],
      foreignColumns: [documentVersions.id, documentVersions.sourceId, documentVersions.accessScopeId],
    }).onDelete("restrict"),
  ],
);

/** Unsearchable until its parent generation is atomically promoted. */
export const documentPublicationChunks = pgTable(
  "document_publication_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => documentPublicationGenerations.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: VECTOR_DIMENSIONS }).notNull(),
    text: text("text").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    pageNumbers: jsonb("page_numbers").$type<number[]>().notNull(),
    sectionHeader: text("section_header"),
    hasTable: boolean("has_table").default(false).notNull(),
    retrievalMetadata: jsonb("retrieval_metadata").$type<CandidateChunkMetadata>().notNull(),
    ...ownershipColumns(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_publication_chunks_generation_chunk_uidx")
      .on(table.generationId, table.chunkIndex),
    index("document_publication_chunks_generation_idx").on(table.generationId),
    check("document_publication_chunks_ownership_ck", ownershipInvariant),
  ],
);

export const documentPublicationChunkSearchDocuments = pgTable(
  "document_publication_chunk_search_documents",
  {
    chunkId: uuid("chunk_id")
      .primaryKey()
      .references(() => documentPublicationChunks.id, { onDelete: "cascade" }),
    searchTokens: text("search_tokens").array().notNull(),
  },
  (table) => [index("document_publication_chunk_search_tokens_idx").using("gin", table.searchTokens)],
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
export type SourceRegistryRevision = typeof sourceRegistryRevisions.$inferSelect;
export type NewSourceRegistryRevision = typeof sourceRegistryRevisions.$inferInsert;
export type AccessScope = typeof accessScopes.$inferSelect;
export type NewAccessScope = typeof accessScopes.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceSchedule = typeof sourceSchedules.$inferSelect;
export type NewSourceSchedule = typeof sourceSchedules.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type SourceDocument = typeof sourceDocuments.$inferSelect;
export type NewSourceDocument = typeof sourceDocuments.$inferInsert;
export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
export type SourceDocumentUrlAlias = typeof sourceDocumentUrlAliases.$inferSelect;
export type NewSourceDocumentUrlAlias = typeof sourceDocumentUrlAliases.$inferInsert;
export type DocumentObservation = typeof documentObservations.$inferSelect;
export type NewDocumentObservation = typeof documentObservations.$inferInsert;
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;
export type NewDiscoveryRun = typeof discoveryRuns.$inferInsert;
