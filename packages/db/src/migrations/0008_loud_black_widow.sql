CREATE TABLE "chunk_candidate_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"chunk_candidate_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"before_text" text NOT NULL,
	"after_text" text NOT NULL,
	"before_content_hash" varchar(64) NOT NULL,
	"after_content_hash" varchar(64) NOT NULL,
	"editor" varchar(255) NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_candidate_edits" ADD CONSTRAINT "chunk_candidate_edits_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_candidate_edits" ADD CONSTRAINT "chunk_candidate_edits_chunk_candidate_id_chunk_candidates_id_fk" FOREIGN KEY ("chunk_candidate_id") REFERENCES "public"."chunk_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_candidate_edits_run_idx" ON "chunk_candidate_edits" USING btree ("ingestion_run_id","created_at");--> statement-breakpoint
CREATE INDEX "chunk_candidate_edits_candidate_idx" ON "chunk_candidate_edits" USING btree ("chunk_candidate_id","created_at");