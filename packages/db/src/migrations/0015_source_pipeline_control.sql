CREATE TABLE "source_registry_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"desired_state" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_scope_key" varchar(100) NOT NULL,
	"external_code" varchar(100) NOT NULL,
	"tenant_id" varchar(100) NOT NULL,
	"knowledge_domain" varchar(50) NOT NULL,
	"source_collection" varchar(100) NOT NULL,
	"amc_slug" varchar(100),
	"enabled" boolean DEFAULT true NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_scopes_external_code_ck" CHECK ("access_scopes"."external_code" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "access_scopes_tenant_compat_ck" CHECK ("access_scopes"."tenant_id" = "access_scopes"."external_code")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_key" varchar(100) NOT NULL,
	"connector" varchar(50) NOT NULL,
	"discovery_config" jsonb NOT NULL,
	"fetch_config" jsonb NOT NULL,
	"review_config" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_schedules" (
	"source_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cron" varchar(100) NOT NULL,
	"timezone" varchar(100) NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" varchar(20) NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_runs_status_ck" CHECK ("discovery_runs"."status" IN ('pending', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "access_scopes" ADD CONSTRAINT "access_scopes_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_schedules" ADD CONSTRAINT "source_schedules_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "source_registry_revisions_checksum_uidx" ON "source_registry_revisions" USING btree ("checksum");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_registry_revisions_one_active_uidx" ON "source_registry_revisions" USING btree ("is_active") WHERE "source_registry_revisions"."is_active" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "access_scopes_key_uidx" ON "access_scopes" USING btree ("access_scope_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "access_scopes_external_code_uidx" ON "access_scopes" USING btree ("external_code");
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_scope_key_uidx" ON "sources" USING btree ("access_scope_id", "source_key");
--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");
--> statement-breakpoint
CREATE INDEX "source_schedules_due_idx" ON "source_schedules" USING btree ("enabled", "next_due_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_runs_source_scheduled_uidx" ON "discovery_runs" USING btree ("source_id", "scheduled_for");
--> statement-breakpoint
CREATE INDEX "discovery_runs_source_created_idx" ON "discovery_runs" USING btree ("source_id", "created_at");
--> statement-breakpoint
CREATE INDEX "discovery_runs_status_idx" ON "discovery_runs" USING btree ("status");
