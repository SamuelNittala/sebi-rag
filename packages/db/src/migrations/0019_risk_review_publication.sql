ALTER TABLE "ingestion_runs" ADD COLUMN "risk_policy_version" varchar(100);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_classification" varchar(20);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_route" varchar(30);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_reason_codes" jsonb;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_evidence" jsonb;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_actor" varchar(255);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "risk_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "access_scopes" ADD COLUMN "emergency_frozen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "access_scopes" ADD COLUMN "emergency_freeze_reason" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "emergency_frozen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "emergency_freeze_reason" text;
--> statement-breakpoint
CREATE TABLE "document_publication_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"config_revision_id" uuid NOT NULL,
	"risk_policy_version" varchar(100) NOT NULL,
	"risk_decision_actor" varchar(255) NOT NULL,
	"parser_version" varchar(50) NOT NULL,
	"chunker_version" varchar(50) NOT NULL,
	"inspector_version" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'staged' NOT NULL,
	"visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL,
	"tenant_id" varchar(100),
	"ownership_manifest_id" varchar(100),
	"ownership_manifest_version" integer,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	CONSTRAINT "document_publication_generations_status_ck" CHECK ("status" IN ('staged', 'published', 'retired', 'stale')),
	CONSTRAINT "document_publication_generations_ownership_ck" CHECK ((
    ("visibility_scope" = 'UNCLASSIFIED' AND "tenant_id" IS NULL AND "ownership_manifest_id" IS NULL AND "ownership_manifest_version" IS NULL)
    OR ("visibility_scope" = 'GLOBAL' AND "tenant_id" IS NULL AND "ownership_manifest_id" IS NOT NULL AND "ownership_manifest_version" > 0)
    OR ("visibility_scope" = 'TENANT' AND "tenant_id" IS NOT NULL AND "ownership_manifest_id" IS NOT NULL AND "ownership_manifest_version" > 0)
  ))
);
--> statement-breakpoint
CREATE TABLE "document_publication_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"text" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"total_chunks" integer NOT NULL,
	"page_numbers" jsonb NOT NULL,
	"section_header" text,
	"has_table" boolean DEFAULT false NOT NULL,
	"retrieval_metadata" jsonb NOT NULL,
	"visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL,
	"tenant_id" varchar(100),
	"ownership_manifest_id" varchar(100),
	"ownership_manifest_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_publication_chunks_ownership_ck" CHECK ((
    ("visibility_scope" = 'UNCLASSIFIED' AND "tenant_id" IS NULL AND "ownership_manifest_id" IS NULL AND "ownership_manifest_version" IS NULL)
    OR ("visibility_scope" = 'GLOBAL' AND "tenant_id" IS NULL AND "ownership_manifest_id" IS NOT NULL AND "ownership_manifest_version" > 0)
    OR ("visibility_scope" = 'TENANT' AND "tenant_id" IS NOT NULL AND "ownership_manifest_id" IS NOT NULL AND "ownership_manifest_version" > 0)
  ))
);
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generations_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_generations" ADD CONSTRAINT "document_publication_generation_owner_fk" FOREIGN KEY ("document_version_id","source_id","access_scope_id") REFERENCES "public"."document_versions"("id","source_id","access_scope_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_publication_chunks" ADD CONSTRAINT "document_publication_chunks_generation_id_document_publication_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."document_publication_generations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "document_publication_generations_run_uidx" ON "document_publication_generations" USING btree ("ingestion_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_publication_generations_one_published_uidx" ON "document_publication_generations" USING btree ("source_document_id") WHERE "status" = 'published';
--> statement-breakpoint
CREATE INDEX "document_publication_generations_version_idx" ON "document_publication_generations" USING btree ("document_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_publication_chunks_generation_chunk_uidx" ON "document_publication_chunks" USING btree ("generation_id","chunk_index");
--> statement-breakpoint
CREATE INDEX "document_publication_chunks_generation_idx" ON "document_publication_chunks" USING btree ("generation_id");
