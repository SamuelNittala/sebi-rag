ALTER TABLE "document_versions" ADD COLUMN "config_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "document_versions_config_revision_idx" ON "document_versions" USING btree ("config_revision_id");
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "config_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pipeline_runs_config_revision_idx" ON "pipeline_runs" USING btree ("config_revision_id");
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "pipeline_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "config_revision_id" uuid;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_pipeline_run_id_pipeline_runs_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_config_revision_id_source_registry_revisions_id_fk" FOREIGN KEY ("config_revision_id") REFERENCES "public"."source_registry_revisions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ingestion_runs_pipeline_run_idx" ON "ingestion_runs" USING btree ("pipeline_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_runs_version_implementation_uidx" ON "ingestion_runs" USING btree ("document_version_id", "config_revision_id", "parser_version", "chunker_version", "inspector_version") WHERE "document_version_id" IS NOT NULL;
