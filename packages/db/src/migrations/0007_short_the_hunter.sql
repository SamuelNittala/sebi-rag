ALTER TABLE "chunks" ADD COLUMN "ingestion_run_id" uuid;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "publication_status" varchar(20) DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "ingestion_run_id" uuid;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "publication_status" varchar(20) DEFAULT 'published' NOT NULL;--> statement-breakpoint
CREATE INDEX "chunks_publication_status_idx" ON "chunks" USING btree ("publication_status");--> statement-breakpoint
CREATE INDEX "html_chunks_publication_status_idx" ON "html_chunks" USING btree ("publication_status");