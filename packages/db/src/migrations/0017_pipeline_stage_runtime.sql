CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"implementation_version" varchar(255) NOT NULL,
	"initial_stage" varchar(50) NOT NULL,
	"initial_stage_implementation_version" varchar(255) NOT NULL,
	"initial_input_checksum" varchar(64) NOT NULL,
	"initial_max_attempts" integer NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_runs_status_ck" CHECK ("pipeline_runs"."status" IN ('active', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "pipeline_runs_initial_input_checksum_ck" CHECK ("pipeline_runs"."initial_input_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "pipeline_runs_initial_max_attempts_ck" CHECK ("pipeline_runs"."initial_max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "stage_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"stage" varchar(50) NOT NULL,
	"implementation_version" varchar(255) NOT NULL,
	"input_checksum" varchar(64) NOT NULL,
	"output_ref" varchar(2000),
	"output_checksum" varchar(64),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"terminal_disposition" varchar(40),
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" varchar(255),
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"error_code" varchar(100),
	"error_message" text,
	"requeued_by" varchar(255),
	"requeued_from_attempt_id" uuid,
	"reused_attempt_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_attempts_status_ck" CHECK ("stage_attempts"."status" IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'reused', 'cancelled')),
	CONSTRAINT "stage_attempts_input_checksum_ck" CHECK ("stage_attempts"."input_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stage_attempts_output_checksum_ck" CHECK ("stage_attempts"."output_checksum" IS NULL OR "stage_attempts"."output_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stage_attempts_attempt_number_ck" CHECK ("stage_attempts"."attempt_number" > 0 AND "stage_attempts"."max_attempts" > 0),
	CONSTRAINT "stage_attempts_lease_epoch_ck" CHECK ("stage_attempts"."lease_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_requeued_from_attempt_id_stage_attempts_id_fk" FOREIGN KEY ("requeued_from_attempt_id") REFERENCES "public"."stage_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_reused_attempt_id_stage_attempts_id_fk" FOREIGN KEY ("reused_attempt_id") REFERENCES "public"."stage_attempts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_schedules" ADD COLUMN "paused_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX "source_schedules_due_idx";
--> statement-breakpoint
CREATE INDEX "source_schedules_due_idx" ON "source_schedules" USING btree ("enabled","paused_at","next_due_at");
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "next_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "lease_owner" varchar(255);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "error_code" varchar(100);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "terminal_disposition" varchar(40);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "retry_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_runs" DROP CONSTRAINT "discovery_runs_status_ck";
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_status_ck" CHECK ("discovery_runs"."status" IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'cancelled'));
--> statement-breakpoint
UPDATE "discovery_runs"
SET "status" = 'retry_wait',
    "next_retry_at" = now(),
    "error_code" = 'MIGRATION_RECOVERY',
    "error_message" = COALESCE("error_message", 'Recovered a pre-lease running discovery row during migration 0017.'),
    "terminal_disposition" = 'RETRY_SCHEDULED'
WHERE "status" = 'running' AND "lease_expires_at" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "discovery_runs"
    WHERE "status" = 'running' AND "lease_expires_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'migration 0017 left an unfenced running discovery row';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_attempts_ck" CHECK ("discovery_runs"."attempt_count" >= 0 AND "discovery_runs"."max_attempts" > 0);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_lease_epoch_ck" CHECK ("discovery_runs"."lease_epoch" >= 0);
--> statement-breakpoint
DROP INDEX "discovery_runs_active_source_idx";
--> statement-breakpoint
CREATE INDEX "discovery_runs_active_source_idx" ON "discovery_runs" USING btree ("source_id") WHERE "discovery_runs"."status" IN ('pending', 'running', 'retry_wait');
--> statement-breakpoint
CREATE INDEX "discovery_runs_claim_idx" ON "discovery_runs" USING btree ("status","next_retry_at");
--> statement-breakpoint
CREATE INDEX "discovery_runs_lease_idx" ON "discovery_runs" USING btree ("status","lease_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_id_source_scope_uidx" ON "document_versions" USING btree ("id","source_id","access_scope_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_id_version_source_scope_uidx" ON "pipeline_runs" USING btree ("id","document_version_id","source_id","access_scope_id");
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_document_owner_fk" FOREIGN KEY ("document_version_id","source_id","access_scope_id") REFERENCES "public"."document_versions"("id","source_id","access_scope_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_attempts" ADD CONSTRAINT "stage_attempts_pipeline_run_owner_fk" FOREIGN KEY ("pipeline_run_id","document_version_id","source_id","access_scope_id") REFERENCES "public"."pipeline_runs"("id","document_version_id","source_id","access_scope_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_version_implementation_uidx" ON "pipeline_runs" USING btree ("document_version_id","implementation_version");
--> statement-breakpoint
CREATE INDEX "pipeline_runs_scope_status_idx" ON "pipeline_runs" USING btree ("access_scope_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "stage_attempts_one_current_compatible_uidx" ON "stage_attempts" USING btree ("pipeline_run_id","stage") WHERE "stage_attempts"."is_current" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "stage_attempts_one_success_compatible_uidx" ON "stage_attempts" USING btree ("document_version_id","stage","implementation_version","input_checksum") WHERE "stage_attempts"."status" = 'succeeded';
--> statement-breakpoint
CREATE INDEX "stage_attempts_claim_due_idx" ON "stage_attempts" USING btree ("status","next_run_at");
--> statement-breakpoint
CREATE INDEX "stage_attempts_expired_lease_idx" ON "stage_attempts" USING btree ("status","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "stage_attempts_dead_letter_idx" ON "stage_attempts" USING btree ("status","completed_at");
