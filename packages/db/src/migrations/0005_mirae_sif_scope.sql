ALTER TABLE "chunks" ADD COLUMN "knowledge_domain" varchar(50) DEFAULT 'mutual_fund' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "source_collection" varchar(100) DEFAULT 'default_corpus' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "amc_slug" varchar(100);--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "knowledge_domain" varchar(50) DEFAULT 'mutual_fund' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "source_collection" varchar(100) DEFAULT 'default_corpus' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "amc_slug" varchar(100);--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "knowledge_domain" varchar(50) DEFAULT 'mutual_fund' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "source_collection" varchar(100) DEFAULT 'default_corpus' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "amc_slug" varchar(100);--> statement-breakpoint
CREATE INDEX "chunks_knowledge_domain_idx" ON "chunks" USING btree ("knowledge_domain");--> statement-breakpoint
CREATE INDEX "chunks_source_collection_idx" ON "chunks" USING btree ("source_collection");--> statement-breakpoint
CREATE INDEX "html_chunks_knowledge_domain_idx" ON "html_chunks" USING btree ("knowledge_domain");--> statement-breakpoint
CREATE INDEX "html_chunks_source_collection_idx" ON "html_chunks" USING btree ("source_collection");