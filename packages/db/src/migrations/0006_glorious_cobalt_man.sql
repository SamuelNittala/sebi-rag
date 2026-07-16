CREATE TABLE "chunk_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"page_numbers" jsonb NOT NULL,
	"token_count" integer NOT NULL,
	"has_table" boolean DEFAULT false NOT NULL,
	"section_header" text,
	"metadata" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunk_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"chunk_candidate_id" uuid,
	"chunk_index" integer,
	"rule_code" varchar(100) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"blocks_approval" boolean DEFAULT false NOT NULL,
	"message" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"reviewer" varchar(255),
	"reviewer_note" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_document_id" uuid NOT NULL,
	"source_name" varchar(500) NOT NULL,
	"source_location" varchar(1000),
	"file_hash" varchar(64) NOT NULL,
	"parser_version" varchar(50) NOT NULL,
	"chunker_version" varchar(50) NOT NULL,
	"inspector_version" varchar(50) NOT NULL,
	"status" varchar(30) NOT NULL,
	"candidate_chunk_count" integer DEFAULT 0 NOT NULL,
	"inspected_chunk_count" integer DEFAULT 0 NOT NULL,
	"flagged_chunk_count" integer DEFAULT 0 NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"blocking_count" integer DEFAULT 0 NOT NULL,
	"reviewer" varchar(255),
	"review_note" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"chunk_flag_id" uuid,
	"event_type" varchar(50) NOT NULL,
	"actor" varchar(255) NOT NULL,
	"note" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD CONSTRAINT "chunk_candidates_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_flags" ADD CONSTRAINT "chunk_flags_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_flags" ADD CONSTRAINT "chunk_flags_chunk_candidate_id_chunk_candidates_id_fk" FOREIGN KEY ("chunk_candidate_id") REFERENCES "public"."chunk_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_chunk_flag_id_chunk_flags_id_fk" FOREIGN KEY ("chunk_flag_id") REFERENCES "public"."chunk_flags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunk_candidates_run_chunk_uidx" ON "chunk_candidates" USING btree ("ingestion_run_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunk_candidates_run_idx" ON "chunk_candidates" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "chunk_flags_run_idx" ON "chunk_flags" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "chunk_flags_candidate_idx" ON "chunk_flags" USING btree ("chunk_candidate_id");--> statement-breakpoint
CREATE INDEX "chunk_flags_status_idx" ON "chunk_flags" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chunk_flags_severity_idx" ON "chunk_flags" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "ingestion_runs_source_document_idx" ON "ingestion_runs" USING btree ("source_type","source_document_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ingestion_runs_created_at_idx" ON "ingestion_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "review_events_run_idx" ON "review_events" USING btree ("ingestion_run_id","created_at");