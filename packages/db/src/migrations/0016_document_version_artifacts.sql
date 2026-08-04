CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_key" varchar(1000) NOT NULL,
	"uri" varchar(2000) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"media_type" varchar(255) NOT NULL,
	"producer_version" varchar(255) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_sha256_ck" CHECK ("artifacts"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifacts_byte_size_ck" CHECK ("artifacts"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"logical_document_key" varchar(500) NOT NULL,
	"canonical_url" varchar(2000) NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"raw_artifact_id" uuid NOT NULL,
	"etag" varchar(1000),
	"last_modified" varchar(1000),
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_sequence_ck" CHECK ("document_versions"."sequence" > 0),
	CONSTRAINT "document_versions_sha256_ck" CHECK ("document_versions"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "source_document_url_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"alias_url" varchar(2000) NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discovery_run_id" uuid NOT NULL,
	"source_document_id" uuid NOT NULL,
	"access_scope_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"observed_url" varchar(2000) NOT NULL,
	"etag" varchar(1000),
	"last_modified" varchar(1000),
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_raw_artifact_id_artifacts_id_fk" FOREIGN KEY ("raw_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_document_url_aliases" ADD CONSTRAINT "source_document_aliases_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_document_url_aliases" ADD CONSTRAINT "source_document_aliases_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_document_url_aliases" ADD CONSTRAINT "source_document_aliases_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_observations" ADD CONSTRAINT "document_observations_discovery_run_id_discovery_runs_id_fk" FOREIGN KEY ("discovery_run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_observations" ADD CONSTRAINT "document_observations_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_observations" ADD CONSTRAINT "document_observations_access_scope_id_access_scopes_id_fk" FOREIGN KEY ("access_scope_id") REFERENCES "public"."access_scopes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_observations" ADD CONSTRAINT "document_observations_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "html_documents" ADD COLUMN "document_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "document_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "html_documents" ADD CONSTRAINT "html_documents_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_key_uidx" ON "artifacts" USING btree ("artifact_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_uri_uidx" ON "artifacts" USING btree ("uri");
--> statement-breakpoint
CREATE INDEX "artifacts_sha256_idx" ON "artifacts" USING btree ("sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_source_key_uidx" ON "source_documents" USING btree ("source_id", "logical_document_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_scope_url_uidx" ON "source_documents" USING btree ("access_scope_id", "canonical_url");
--> statement-breakpoint
CREATE UNIQUE INDEX "sources_id_scope_uidx" ON "sources" USING btree ("id", "access_scope_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_id_source_scope_uidx" ON "source_documents" USING btree ("id", "source_id", "access_scope_id");
--> statement-breakpoint
CREATE INDEX "source_documents_current_version_idx" ON "source_documents" USING btree ("current_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_hash_uidx" ON "document_versions" USING btree ("source_document_id", "content_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_sequence_uidx" ON "document_versions" USING btree ("source_document_id", "sequence");
--> statement-breakpoint
CREATE INDEX "document_versions_scope_source_idx" ON "document_versions" USING btree ("access_scope_id", "source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "source_document_aliases_scope_url_uidx" ON "source_document_url_aliases" USING btree ("access_scope_id", "alias_url");
--> statement-breakpoint
CREATE INDEX "source_document_aliases_document_idx" ON "source_document_url_aliases" USING btree ("source_document_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "document_observations_run_document_uidx" ON "document_observations" USING btree ("discovery_run_id", "source_document_id");
--> statement-breakpoint
CREATE INDEX "document_observations_source_observed_idx" ON "document_observations" USING btree ("source_id", "observed_at");
--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_source_scope_fk" FOREIGN KEY ("source_id", "access_scope_id") REFERENCES "public"."sources"("id", "access_scope_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_owner_fk" FOREIGN KEY ("source_document_id", "source_id", "access_scope_id") REFERENCES "public"."source_documents"("id", "source_id", "access_scope_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "source_document_url_aliases" ADD CONSTRAINT "source_document_aliases_document_owner_fk" FOREIGN KEY ("source_document_id", "source_id", "access_scope_id") REFERENCES "public"."source_documents"("id", "source_id", "access_scope_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_observations" ADD CONSTRAINT "document_observations_document_owner_fk" FOREIGN KEY ("source_document_id", "source_id", "access_scope_id") REFERENCES "public"."source_documents"("id", "source_id", "access_scope_id") ON DELETE restrict ON UPDATE no action;
