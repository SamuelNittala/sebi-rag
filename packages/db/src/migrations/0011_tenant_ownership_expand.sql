CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TABLE "api_key_tenant_scopes" (
	"api_key_id" uuid NOT NULL,
	"tenant_id" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_tenant_scopes_api_key_id_tenant_id_pk" PRIMARY KEY("api_key_id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_ownership_manifest_applications" (
	"manifest_id" varchar(100) NOT NULL,
	"manifest_version" integer NOT NULL,
	"manifest_checksum" varchar(64) NOT NULL,
	"inventory_checksum" varchar(64) NOT NULL,
	"approved_by" varchar(255) NOT NULL,
	"approved_at" timestamp NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_ownership_manifest_applications_manifest_id_manifest_version_pk" PRIMARY KEY("manifest_id","manifest_version"),
	CONSTRAINT "tenant_ownership_manifest_version_ck" CHECK ("tenant_ownership_manifest_applications"."manifest_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "key_fingerprint" varchar(64) GENERATED ALWAYS AS (encode(digest("key", 'sha256'), 'hex')) STORED;--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "html_chunks" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "visibility_scope" varchar(20) DEFAULT 'UNCLASSIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "ownership_manifest_id" varchar(100);--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "ownership_manifest_version" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "correlation_id" varchar(100);--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "tenant_id" varchar(100);--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "operation" varchar(100);--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "decision" varchar(20);--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "reason_code" varchar(100);--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "result_count" integer;--> statement-breakpoint
ALTER TABLE "api_key_tenant_scopes" ADD CONSTRAINT "api_key_tenant_scopes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_tenant_scopes_tenant_idx" ON "api_key_tenant_scopes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_ownership_manifest_checksum_uidx" ON "tenant_ownership_manifest_applications" USING btree ("manifest_checksum");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_fingerprint_unique" UNIQUE("key_fingerprint");--> statement-breakpoint
ALTER TABLE "chunk_candidates" ADD CONSTRAINT "chunk_candidates_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));--> statement-breakpoint
ALTER TABLE "html_chunks" ADD CONSTRAINT "html_chunks_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));--> statement-breakpoint
ALTER TABLE "html_documents" ADD CONSTRAINT "html_documents_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_ownership_invariant_ck" CHECK ((
  ("visibility_scope" = 'UNCLASSIFIED'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NULL
    AND "ownership_manifest_version" IS NULL)
  OR
  ("visibility_scope" = 'GLOBAL'
    AND "tenant_id" IS NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
  OR
  ("visibility_scope" = 'TENANT'
    AND "tenant_id" IS NOT NULL
    AND "ownership_manifest_id" IS NOT NULL
    AND "ownership_manifest_version" > 0)
));
