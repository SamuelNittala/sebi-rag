DROP INDEX IF EXISTS "ingestion_runs_version_implementation_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_runs_version_implementation_uidx"
  ON "ingestion_runs" USING btree (
    "document_version_id",
    "pipeline_run_id",
    "config_revision_id",
    "parser_version",
    "chunker_version",
    "inspector_version"
  )
  WHERE "document_version_id" IS NOT NULL;
