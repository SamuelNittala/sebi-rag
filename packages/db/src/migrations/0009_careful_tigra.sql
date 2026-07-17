ALTER TABLE "chunks" ADD COLUMN "retrieval_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "retrieval_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "review_purpose" varchar(20) DEFAULT 'content' NOT NULL;