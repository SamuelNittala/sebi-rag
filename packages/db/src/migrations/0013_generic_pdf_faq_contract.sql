ALTER TABLE "documents" ADD COLUMN "document_kind" varchar(50) DEFAULT 'scheme' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "title" varchar(500);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "publisher" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_url" varchar(1000);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_date" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "authority" varchar(100);--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "warning_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "fund_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "amc_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "scheme_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "scheme_category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "document_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "sebi_scheme_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "sebi_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "document_kind" varchar(50) DEFAULT 'scheme' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "document_title" varchar(500);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "publisher" varchar(255);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "source_url" varchar(1000);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "source_date" varchar(20);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "authority" varchar(100);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "question_number" varchar(50);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "normalized_question_key" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "original_question" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "continuation_index" integer;--> statement-breakpoint
CREATE INDEX "chunks_normalized_question_idx" ON "chunks" USING btree ("normalized_question_key");--> statement-breakpoint
CREATE INDEX "chunks_generic_document_idx" ON "chunks" USING btree ("document_kind","source_url","publication_status");
