CREATE TABLE "html_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(500) NOT NULL,
	"source_url" varchar(1000) NOT NULL,
	"source_slug" varchar(255) NOT NULL,
	"file_path" varchar(500) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"content_category" varchar(50) NOT NULL,
	"source" varchar(100) NOT NULL,
	"chunk_count" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"scraped_at" timestamp NOT NULL,
	"ingested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "html_documents_source_url_unique" UNIQUE("source_url"),
	CONSTRAINT "html_documents_file_hash_unique" UNIQUE("file_hash")
);
--> statement-breakpoint
CREATE TABLE "html_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"text" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"total_chunks" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"document_title" varchar(500) NOT NULL,
	"source_url" varchar(1000) NOT NULL,
	"content_category" varchar(50) NOT NULL,
	"section_heading" text,
	"has_table" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "html_chunks" ADD CONSTRAINT "html_chunks_document_id_html_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."html_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "html_documents_content_category_idx" ON "html_documents" USING btree ("content_category");
--> statement-breakpoint
CREATE INDEX "html_documents_source_idx" ON "html_documents" USING btree ("source");
--> statement-breakpoint
CREATE INDEX "html_documents_status_idx" ON "html_documents" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "html_chunks_document_id_idx" ON "html_chunks" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "html_chunks_content_category_idx" ON "html_chunks" USING btree ("content_category");
--> statement-breakpoint
CREATE INDEX "html_chunks_document_chunk_idx" ON "html_chunks" USING btree ("document_id","chunk_index");
--> statement-breakpoint
CREATE INDEX "html_chunks_embedding_idx" ON "html_chunks" USING hnsw ("embedding" vector_cosine_ops);
