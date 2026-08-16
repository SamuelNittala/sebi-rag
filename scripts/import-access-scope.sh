#!/usr/bin/env bash

set -Eeuo pipefail

BUNDLE_DIR="${1:?Usage: import-access-scope.sh <bundle-directory>}"
: "${DATABASE_URL:?DATABASE_URL is required}"

BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
[[ "$BUNDLE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "Bundle path contains unsupported characters" >&2
  exit 1
}

TABLES=(
  source_registry_revisions access_scopes sources source_schedules artifacts
  source_documents document_versions source_document_url_aliases discovery_runs
  document_observations pipeline_runs stage_attempts ingestion_runs chunk_candidates
  chunk_flags chunk_candidate_edits review_events document_publication_generations
  document_publication_chunks document_publication_chunk_search_documents
)

for required in manifest.json SHA256SUMS artifacts.tar.gz; do
  test -f "$BUNDLE_DIR/$required" || {
    echo "Missing bundle file: $required" >&2
    exit 1
  }
done
for table in "${TABLES[@]}"; do
  test -f "$BUNDLE_DIR/data/$table.csv" || {
    echo "Missing bundle table: $table" >&2
    exit 1
  }
done

(cd "$BUNDLE_DIR" && sha256sum -c SHA256SUMS)

TENANT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenantId"])' "$BUNDLE_DIR/manifest.json")"
[[ "$TENANT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "Manifest tenant ID contains unsupported characters" >&2
  exit 1
}

SQL_FILE="$(mktemp "${TMPDIR:-/tmp}/fund-scope-import.XXXXXX.sql")"
trap 'rm -f -- "$SQL_FILE"' EXIT

{
  cat <<SQL
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '30min';

DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM access_scopes WHERE tenant_id = '$TENANT_ID') THEN
    RAISE EXCEPTION 'Tenant $TENANT_ID already exists; refusing to overwrite it';
  END IF;
END \$\$;

DROP SCHEMA IF EXISTS fund_scope_import CASCADE;
CREATE SCHEMA fund_scope_import;
SQL

  for table in "${TABLES[@]}"; do
    printf 'CREATE UNLOGGED TABLE fund_scope_import.%s (LIKE public.%s INCLUDING DEFAULTS INCLUDING GENERATED);\n' "$table" "$table"
  done
  for table in "${TABLES[@]}"; do
    printf '\\copy fund_scope_import.%s FROM %s WITH (FORMAT csv, HEADER true)\n' \
      "$table" "'$BUNDLE_DIR/data/$table.csv'"
  done

  for table in "${TABLES[@]}"; do
    expected="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["counts"][sys.argv[2]])' "$BUNDLE_DIR/manifest.json" "$table")"
    [[ "$expected" =~ ^[0-9]+$ ]] || {
      echo "Invalid expected count for $table" >&2
      exit 1
    }
    printf "DO \$\$ BEGIN IF (SELECT count(*) FROM fund_scope_import.%s) <> %s THEN RAISE EXCEPTION 'Staged count mismatch for %s'; END IF; END \$\$;\n" \
      "$table" "$expected" "$table"
  done

  cat <<'SQL'
INSERT INTO public.source_registry_revisions SELECT * FROM fund_scope_import.source_registry_revisions;
INSERT INTO public.access_scopes SELECT * FROM fund_scope_import.access_scopes;
INSERT INTO public.sources SELECT * FROM fund_scope_import.sources;
INSERT INTO public.source_schedules SELECT * FROM fund_scope_import.source_schedules;
INSERT INTO public.artifacts SELECT * FROM fund_scope_import.artifacts;

DO $$
DECLARE
  column_list text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
  INTO column_list
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'source_documents'
    AND column_name <> 'current_version_id';
  EXECUTE format(
    'INSERT INTO public.source_documents (%1$s) SELECT %1$s FROM fund_scope_import.source_documents',
    column_list
  );
END $$;

INSERT INTO public.document_versions SELECT * FROM fund_scope_import.document_versions;
UPDATE public.source_documents destination
SET current_version_id = staged.current_version_id
FROM fund_scope_import.source_documents staged
WHERE destination.id = staged.id;

INSERT INTO public.source_document_url_aliases SELECT * FROM fund_scope_import.source_document_url_aliases;
INSERT INTO public.discovery_runs SELECT * FROM fund_scope_import.discovery_runs;
INSERT INTO public.document_observations SELECT * FROM fund_scope_import.document_observations;
INSERT INTO public.pipeline_runs SELECT * FROM fund_scope_import.pipeline_runs;
INSERT INTO public.stage_attempts SELECT * FROM fund_scope_import.stage_attempts;
INSERT INTO public.ingestion_runs SELECT * FROM fund_scope_import.ingestion_runs;
INSERT INTO public.chunk_candidates SELECT * FROM fund_scope_import.chunk_candidates;
INSERT INTO public.chunk_flags SELECT * FROM fund_scope_import.chunk_flags;
INSERT INTO public.chunk_candidate_edits SELECT * FROM fund_scope_import.chunk_candidate_edits;
INSERT INTO public.review_events SELECT * FROM fund_scope_import.review_events;
INSERT INTO public.document_publication_generations SELECT * FROM fund_scope_import.document_publication_generations;
INSERT INTO public.document_publication_chunks SELECT * FROM fund_scope_import.document_publication_chunks;

DO $$
BEGIN
  IF EXISTS (
    (SELECT * FROM fund_scope_import.document_publication_chunk_search_documents
      EXCEPT SELECT * FROM public.document_publication_chunk_search_documents)
    UNION ALL
    (SELECT * FROM public.document_publication_chunk_search_documents
      WHERE chunk_id IN (SELECT id FROM fund_scope_import.document_publication_chunks)
      EXCEPT SELECT * FROM fund_scope_import.document_publication_chunk_search_documents)
  ) THEN
    RAISE EXCEPTION 'Trigger-generated publication search documents do not match the export';
  END IF;
END $$;

DROP SCHEMA fund_scope_import CASCADE;
COMMIT;
SQL
} > "$SQL_FILE"

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SQL_FILE"

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
    select
      scope.tenant_id,
      count(distinct generation.id)::int as published_documents,
      count(chunk.id)::int as published_chunks
    from access_scopes scope
    join document_publication_generations generation
      on generation.access_scope_id = scope.id and generation.status = 'published'
    join document_publication_chunks chunk on chunk.generation_id = generation.id
    where scope.tenant_id = '$TENANT_ID'
    group by scope.tenant_id;
  "

echo "Import complete for tenant $TENANT_ID"
