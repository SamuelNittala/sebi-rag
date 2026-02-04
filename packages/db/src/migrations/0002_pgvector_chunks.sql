-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create chunks table for storing document chunks with embeddings
CREATE TABLE IF NOT EXISTS "chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "text" text NOT NULL,
  "chunk_index" integer NOT NULL,
  "total_chunks" integer NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "document_filename" varchar(255) NOT NULL,
  "page_numbers" jsonb NOT NULL,
  "fund_name" varchar(255) NOT NULL,
  "amc_name" varchar(255) NOT NULL,
  "scheme_type" varchar(50) NOT NULL,
  "scheme_category" varchar(100) NOT NULL,
  "doc_type" varchar(50) NOT NULL,
  "document_date" varchar(20) NOT NULL,
  "has_table" boolean DEFAULT false NOT NULL,
  "section_header" text,
  "sebi_scheme_id" varchar(50) NOT NULL,
  "sebi_url" varchar(500) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Create indexes for filtering
CREATE INDEX IF NOT EXISTS "chunks_document_id_idx" ON "chunks" ("document_id");
CREATE INDEX IF NOT EXISTS "chunks_fund_name_idx" ON "chunks" ("fund_name");
CREATE INDEX IF NOT EXISTS "chunks_amc_name_idx" ON "chunks" ("amc_name");
CREATE INDEX IF NOT EXISTS "chunks_scheme_type_idx" ON "chunks" ("scheme_type");
CREATE INDEX IF NOT EXISTS "chunks_doc_type_idx" ON "chunks" ("doc_type");
CREATE INDEX IF NOT EXISTS "chunks_sebi_scheme_id_idx" ON "chunks" ("sebi_scheme_id");
CREATE INDEX IF NOT EXISTS "chunks_document_chunk_idx" ON "chunks" ("document_id", "chunk_index");

-- Create HNSW index for vector similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx" ON "chunks"
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
