#!/usr/bin/env bash

set -Eeuo pipefail

TENANT_ID="${1:?Usage: export-access-scope.sh <tenant-id> <output-directory>}"
OUTPUT_DIR="${2:?Usage: export-access-scope.sh <tenant-id> <output-directory>}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.dev.yml}"
ENV_FILE="${ENV_FILE:-.env}"

[[ "$TENANT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "Tenant ID contains unsupported characters" >&2
  exit 1
}
[[ ! -e "$OUTPUT_DIR" ]] || {
  echo "Output path already exists: $OUTPUT_DIR" >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR/data"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

copy_query() {
  local table="$1"
  local query="$2"
  "${COMPOSE[@]}" exec -T \
    -e EXPORT_QUERY="$query" \
    postgres sh -ceu '
      psql -X -v ON_ERROR_STOP=1 \
        -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -c "\copy ($EXPORT_QUERY) TO STDOUT WITH (FORMAT csv, HEADER true)"
    ' > "$OUTPUT_DIR/data/$table.csv"
}

scope_id="(select id from access_scopes where tenant_id = '$TENANT_ID')"
source_ids="(select id from sources where access_scope_id = $scope_id)"
pipeline_ids="(select id from pipeline_runs where access_scope_id = $scope_id)"
ingestion_ids="(select ir.id from ingestion_runs ir join pipeline_runs pr on pr.id = ir.pipeline_run_id where pr.access_scope_id = $scope_id)"
generation_ids="(select id from document_publication_generations where access_scope_id = $scope_id)"

copy_query source_registry_revisions "
  select revision.* from source_registry_revisions revision
  where revision.id in (
    select config_revision_id from access_scopes where id = $scope_id
    union select config_revision_id from sources where access_scope_id = $scope_id
    union select config_revision_id from document_versions where access_scope_id = $scope_id
    union select config_revision_id from discovery_runs where source_id in $source_ids
    union select config_revision_id from pipeline_runs where access_scope_id = $scope_id
    union select config_revision_id from ingestion_runs where id in $ingestion_ids
    union select config_revision_id from document_publication_generations where access_scope_id = $scope_id
  ) order by revision.applied_at, revision.id"
copy_query access_scopes "select * from access_scopes where id = $scope_id order by id"
copy_query sources "select * from sources where access_scope_id = $scope_id order by id"
copy_query source_schedules "select * from source_schedules where source_id in $source_ids order by source_id"
copy_query artifacts "
  select artifact.* from artifacts artifact
  where artifact.id in (select raw_artifact_id from document_versions where access_scope_id = $scope_id)
  order by artifact.id"
copy_query source_documents "select * from source_documents where access_scope_id = $scope_id order by id"
copy_query document_versions "select * from document_versions where access_scope_id = $scope_id order by id"
copy_query source_document_url_aliases "select * from source_document_url_aliases where access_scope_id = $scope_id order by id"
copy_query discovery_runs "select * from discovery_runs where source_id in $source_ids order by created_at, id"
copy_query document_observations "select * from document_observations where access_scope_id = $scope_id order by observed_at, id"
copy_query pipeline_runs "select * from pipeline_runs where access_scope_id = $scope_id order by created_at, id"
copy_query stage_attempts "select * from stage_attempts where pipeline_run_id in $pipeline_ids order by created_at, id"
copy_query ingestion_runs "select * from ingestion_runs where id in $ingestion_ids order by created_at, id"
copy_query chunk_candidates "select * from chunk_candidates where ingestion_run_id in $ingestion_ids order by ingestion_run_id, chunk_index, id"
copy_query chunk_flags "select * from chunk_flags where ingestion_run_id in $ingestion_ids order by ingestion_run_id, chunk_index, id"
copy_query chunk_candidate_edits "select * from chunk_candidate_edits where ingestion_run_id in $ingestion_ids order by created_at, id"
copy_query review_events "select * from review_events where ingestion_run_id in $ingestion_ids order by created_at, id"
copy_query document_publication_generations "select * from document_publication_generations where id in $generation_ids order by staged_at, id"
copy_query document_publication_chunks "select * from document_publication_chunks where generation_id in $generation_ids order by generation_id, chunk_index, id"
copy_query document_publication_chunk_search_documents "
  select search.* from document_publication_chunk_search_documents search
  join document_publication_chunks chunk on chunk.id = search.chunk_id
  where chunk.generation_id in $generation_ids order by search.chunk_id"

manifest_query="
  select jsonb_pretty(jsonb_build_object(
    'schemaVersion', 1,
    'tenantId', '$TENANT_ID',
    'createdAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
    'embeddingDimensions', 1024,
    'counts', jsonb_build_object(
      'source_registry_revisions', (select count(*) from source_registry_revisions revision where revision.id in (
        select config_revision_id from access_scopes where id = $scope_id
        union select config_revision_id from sources where access_scope_id = $scope_id
        union select config_revision_id from document_versions where access_scope_id = $scope_id
        union select config_revision_id from discovery_runs where source_id in $source_ids
        union select config_revision_id from pipeline_runs where access_scope_id = $scope_id
        union select config_revision_id from ingestion_runs where id in $ingestion_ids
        union select config_revision_id from document_publication_generations where access_scope_id = $scope_id)),
      'access_scopes', (select count(*) from access_scopes where id = $scope_id),
      'sources', (select count(*) from sources where access_scope_id = $scope_id),
      'source_schedules', (select count(*) from source_schedules where source_id in $source_ids),
      'artifacts', (select count(*) from artifacts where id in (select raw_artifact_id from document_versions where access_scope_id = $scope_id)),
      'source_documents', (select count(*) from source_documents where access_scope_id = $scope_id),
      'document_versions', (select count(*) from document_versions where access_scope_id = $scope_id),
      'source_document_url_aliases', (select count(*) from source_document_url_aliases where access_scope_id = $scope_id),
      'discovery_runs', (select count(*) from discovery_runs where source_id in $source_ids),
      'document_observations', (select count(*) from document_observations where access_scope_id = $scope_id),
      'pipeline_runs', (select count(*) from pipeline_runs where access_scope_id = $scope_id),
      'stage_attempts', (select count(*) from stage_attempts where pipeline_run_id in $pipeline_ids),
      'ingestion_runs', (select count(*) from ingestion_runs where id in $ingestion_ids),
      'chunk_candidates', (select count(*) from chunk_candidates where ingestion_run_id in $ingestion_ids),
      'chunk_flags', (select count(*) from chunk_flags where ingestion_run_id in $ingestion_ids),
      'chunk_candidate_edits', (select count(*) from chunk_candidate_edits where ingestion_run_id in $ingestion_ids),
      'review_events', (select count(*) from review_events where ingestion_run_id in $ingestion_ids),
      'document_publication_generations', (select count(*) from document_publication_generations where id in $generation_ids),
      'document_publication_chunks', (select count(*) from document_publication_chunks where generation_id in $generation_ids),
      'document_publication_chunk_search_documents', (select count(*) from document_publication_chunk_search_documents search join document_publication_chunks chunk on chunk.id = search.chunk_id where chunk.generation_id in $generation_ids)
    )
  ))"
"${COMPOSE[@]}" exec -T \
  -e MANIFEST_QUERY="$manifest_query" \
  postgres sh -ceu '
    psql -X -qAt -v ON_ERROR_STOP=1 \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      -c "$MANIFEST_QUERY"
  ' > "$OUTPUT_DIR/manifest.json"

"${COMPOSE[@]}" exec -T pipeline-stage-worker \
  tar -C /var/lib/mf-rag/artifacts -czf - . > "$OUTPUT_DIR/artifacts.tar.gz"

(
  cd "$OUTPUT_DIR"
  find data -type f -print0 | sort -z | xargs -0 sha256sum
  sha256sum manifest.json artifacts.tar.gz
) > "$OUTPUT_DIR/SHA256SUMS"

echo "Export complete: $OUTPUT_DIR"
