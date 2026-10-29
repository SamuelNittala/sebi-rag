# Docker-only local development

Docker Compose is the only supported local execution path. Do not run Bun,
Ollama, the MCP server, migrations, tests, ingestion, publication, or
evaluations directly on the host. This workflow does not use SSH or a remote
database.

## Configure

```bash
cp .env.example .env
```

Replace `MF_RAG_API_KEY`, `AMC_SCOPE`, and the review credentials in `.env`.
The Compose configuration fails before startup when any required value is
missing. The local credential is stored in PostgreSQL only as a SHA-256
fingerprint and is granted only the configured scope.

Use this command prefix for every task:

```bash
docker compose --env-file .env -f docker/docker-compose.dev.yml
```

## Database-only tasks

These commands do not start or download Ollama or the reranker.

```bash
# Rebuild the runner image.
docker compose --env-file .env -f docker/docker-compose.dev.yml build runner

# Start a clean database and apply every migration.
docker compose --env-file .env -f docker/docker-compose.dev.yml down --volumes
docker compose --env-file .env -f docker/docker-compose.dev.yml up -d --wait postgres
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm migrate

# Run type checking, all tests, or the tenant-isolation suite in the runner.
# The runner retains the development DATABASE_URL for operational commands.
# Integration tests select the separately migrated TEST_DATABASE_URL, so they
# cannot delete or truncate the development corpus in `postgres`.
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner x tsc --noEmit
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner test
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm \
  --entrypoint sh runner -ceu '
    bun test apps/mcp-server/src/request-context.test.ts
    bun test packages/core/src/rate-limiter/auth.integration.test.ts
    bun test packages/vector/src/tenant-scope.integration.test.ts
  '
```

Database-backed pipeline tests must use the migrated test service as their
actual `DATABASE_URL`, because the database package is initialized once per Bun
process. Destructive fixture files must run serially to avoid truncating one
another's rows:

```bash
docker compose --env-file .env -f docker/docker-compose.dev.yml --profile tools run --rm \
  -e DATABASE_URL=postgresql://postgres:postgres@postgres-test:5432/mf_rag_test \
  runner test --parallel=1 packages/db/src apps/pipeline/src
```

## Disabled document-pipeline roles

The local artifact store is a named Docker volume shared by the two workers.
Start the explicit process roles with claims disabled to smoke health and
shutdown wiring without fetching any tenant source:

```bash
PIPELINE_CLAIMS_ENABLED=false docker compose --env-file .env \
  -f docker/docker-compose.dev.yml --profile pipeline up -d --build --wait \
  postgres migrate pipeline-scheduler pipeline-discovery-worker pipeline-stage-worker

docker compose --env-file .env -f docker/docker-compose.dev.yml \
  --profile pipeline ps
```

Scheduler readiness probes PostgreSQL. Worker readiness probes PostgreSQL and
real filesystem artifact access. Claims may be enabled only with a reviewed
immutable-image worker module.
Stopping these roles does not stop MCP retrieval or the review API.

## Full local stack

The first startup downloads `bge-m3` and the configured reranker model into
named Docker volumes. Later starts reuse those volumes.

```bash
docker compose --env-file .env -f docker/docker-compose.dev.yml up -d --build --wait
docker compose --env-file .env -f docker/docker-compose.dev.yml ps
docker compose --env-file .env -f docker/docker-compose.dev.yml logs mcp-server review-api
```

Open <http://127.0.0.1:3000/review>. The review API calls MCP over the Compose
network with the server-side credential and exact `AMC_SCOPE`; neither value is
accepted from a review query.

## Named workflow tasks

All paths are container paths under the repository mounted at `/app`.
Downloaded PDFs, scraper state, and generated previews belong under `data/`,
whose runtime directories are ignored by Git.

```bash
# Source download
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  run apps/scraper/src/index.ts download

# Parse and stage a source for review
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  run apps/ingestion/src/index.ts data/pdfs/<source>.pdf \
  --visibility-scope GLOBAL \
  --ownership-manifest-id <trusted-manifest-id> \
  --ownership-manifest-version <positive-version>

# For tenant-owned material, use TENANT; ownership is bound to the runner's
# protected AMC_SCOPE and no tenant CLI argument is accepted.

# Publish an already approved review run
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  run review:publish <review-run-id> --actor <reviewer-name>

# Retrieval evaluation through authenticated MCP
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  --entrypoint sh -lc 'bun run eval:basic docker-local \
  --mcp-url http://mcp-server:3001/mcp \
  --mcp-api-key "$MF_RAG_API_KEY" --amc-scope "$AMC_SCOPE"'

# Deterministic evaluator-contract smoke test (no corpus or embeddings needed)
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  run retrieval:evaluate-general-mf-faq --mode=replay

# Actual published-corpus gate (both approved FAQ sources and Ollama required)
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  run retrieval:evaluate-general-mf-faq
```

The evaluation expands both values inside the runner, so the bearer does not
enter shell history. Never use a real production credential locally.
Application security logs are structured records containing correlation ID,
internal key ID, authorized tenant, operation, decision, reason, and result
count. They must not contain bearer values, authorization headers, connection
strings, or raw questions.

Replay mode proves the evaluator contract; it is not retrieval-quality
evidence. Live mode is the corpus gate. The checked-in thresholds require 100%
top-three relevance for SIP, NAV, KYC, tax, nomination, and process; complete
generic citations; SIF exclusion; lexical participation; identical global FAQ
IDs for tenant A and B; and no repeated normalized question above half the
result set. The report records missing authority, stale sources, and
cross-authority conflicts.

The report keeps investor-agent parity marked unmet until the
[external MCP contract](../contracts/investor-agent-mcp-transport.md) checklist
is complete.

## Fail-closed checks

```bash
# Must fail configuration with a clear missing-secret error.
env -u MF_RAG_API_KEY docker compose --env-file /dev/null \
  -f docker/docker-compose.dev.yml config

# A request without both headers must fail before MCP dispatch.
docker compose --env-file .env -f docker/docker-compose.dev.yml run --rm runner \
  -e "const r=await fetch('http://mcp-server:3001/mcp'); console.log(r.status); process.exit(r.status===400?0:1)"
```

Do not activate this boundary in production until every MCP client, including
investor-agent and the in-repo review client, sends a protected bearer
credential and a static canonical `AMC_SCOPE`. There is no absent-scope
compatibility mode and no permitted rollback to an unscoped reader.

## Stop or reset

```bash
docker compose --env-file .env -f docker/docker-compose.dev.yml down
docker compose --env-file .env -f docker/docker-compose.dev.yml down --volumes
```

The second command deletes only this Compose project's local named volumes.
