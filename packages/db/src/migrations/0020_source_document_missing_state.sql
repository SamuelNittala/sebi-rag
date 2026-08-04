ALTER TABLE "source_documents" ADD COLUMN "missing_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "missing_evidence_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "last_present_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_missing_evidence_ck" CHECK ("missing_evidence_count" >= 0);
--> statement-breakpoint
CREATE INDEX "source_documents_missing_idx" ON "source_documents" USING btree ("source_id", "missing_since");
