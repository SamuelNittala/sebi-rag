# MF-RAG: Mutual Fund Document Search for Claude

An MCP server that enables Claude Desktop and Claude Code to answer questions about Indian mutual funds using official SEBI documents.

## Why LLM-Free?

Traditional RAG pipelines use a local LLM to generate answers:

```
Query → Embed → Search → Context → Local LLM → Answer
                                       ↓
                               Slow, inaccurate, jailbreak-prone
```

This project skips the local LLM entirely:

```
Query → Embed → Hybrid search → RRF → BGE rerank → Return chunks → Claude synthesizes
                                                                    ↓
                                                            Accurate and safe
```

### Comparison

| Metric | With Local LLM | LLM-Free |
|--------|----------------|----------|
| **Latency** | 8-16 seconds | Retrieval latency plus optional cross-encoder reranking |
| **Accuracy** | Misses table data | Parses tables correctly |
| **Security** | Can be jailbroken | No LLM to jailbreak |
| **Cost** | LLM inference | Self-hosted embedding and optional reranker inference |

The local LLM (qwen2.5:7b) failed to extract expense ratios from tables that were right in its context. Claude handles this correctly.

## Features

- **Semantic search** across 500+ mutual fund schemes
- **Cross-encoder reranking** with `BAAI/bge-reranker-v2-m3` after hybrid retrieval
- **Document types**: SID, KIM, Factsheets from SEBI
- **Filters**: By fund name, AMC, scheme type, document type
- **Citations**: Every answer includes source documents with page numbers and SEBI URLs
- **Rate limiting**: Optional API key-based limits for cloud deployment

## Quick Start

Local development and verification are Docker Compose-only. Host Bun, host
Ollama, direct server execution, SSH, and remote databases are not supported
workflow paths.

```bash
cp .env.example .env
# Replace the local-only credential, AMC scope, and review placeholders.
docker compose --env-file .env -f docker/docker-compose.dev.yml up -d --build --wait
```

Open <http://127.0.0.1:3000/review>. See the
[Docker-only local runbook](docs/runbooks/docker-local-development.md) for
migrations, tests, ingestion, review publication, evaluation, reset, and
fail-closed checks.

### Client contract

Every MCP client must send a protected bearer credential and exactly one
canonical static `X-AMC-Scope` value. Production activation remains blocked
until investor-agent and every other client has adopted both fields. Missing
scope has no compatibility fallback, and rollback to an unscoped reader is not
allowed.

## Example Queries

- "What mutual fund schemes do you have access to?"
- "Compare the expense ratios of HDFC and ICICI equity funds"
- "What are the risk factors for debt mutual funds?"
- "Which funds have the lowest expense ratios?"
- "What is the investment objective of Axis Bluechip Fund?"

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │     │   MCP Server     │     │   PostgreSQL    │
│  or Claude Code │────▶│   (Bun + TS)     │────▶│   + pgvector    │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                         ┌───────┴────────┐
                         ▼                ▼
                ┌─────────────────┐ ┌────────────────────┐
                │     Ollama      │ │ Hugging Face TEI   │
                │    (bge-m3)     │ │ bge-reranker-v2-m3│
                │  Embedding Only │ │   Cross-encoder    │
                └─────────────────┘ └────────────────────┘
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `query_mutual_funds` | Semantic search, returns chunks for Claude to synthesize |
| `search_mutual_fund_docs` | Lower-level search with excerpts |
| `list_schemes` | List all indexed mutual fund schemes |
| `check_status` | Health check for services |

## Project Structure

```
mf-pdf-rag/
├── apps/
│   ├── mcp-server/      # MCP server (main entry point)
│   ├── ingestion/       # PDF parsing and chunking pipeline
│   ├── scraper/         # SEBI document scraper
│   ├── api/             # REST API (optional)
│   └── cli/             # Command-line interface
├── packages/
│   ├── core/            # Shared business logic
│   │   ├── embedding/   # Ollama embedder
│   │   ├── rate-limiter/# API rate limiting
│   │   └── ...
│   ├── db/              # Drizzle ORM + migrations
│   ├── vector/          # pgvector client
│   └── types/           # Shared TypeScript types
├── scripts/             # Utility scripts
└── docker/              # Docker compose for PostgreSQL
```

## Development

Use only the commands in the
[Docker-only local runbook](docs/runbooks/docker-local-development.md). The
one-shot `runner` service executes repository commands inside the same image
and network as PostgreSQL, Redis, embeddings, reranking, MCP, and review.

### Pre-embedding chunk review

PDF and HTML ingestion now stop after deterministic inspection by default. The
candidate chunks and all findings are stored outside the searchable vector set,
so a malformed chunk cannot reach retrieval before review.

The runbook provides Compose commands for migration, ingestion, opening the
review UI, and publishing an approved review run.

The review screen shows every flagged chunk for a document on one page, with
previous and next chunk context, source pages, inferred scope, rule evidence,
and an audit-logged reviewer decision. Use **Edit all candidate chunks** to
correct extracted text before approval. Each save requires a reason, records
the complete before/after revision, and reinspects the entire document because
an edit can affect neighboring chunk boundaries. Retrieval only reads `published` rows;
staged and retired versions are excluded. `bun run reingest:mirae-sif --apply`
creates review runs without deleting the currently published Mirae SIF vectors.

## Data Source

Official mutual fund documents from [SEBI](https://www.sebi.gov.in/) (Securities and Exchange Board of India):

- **Scheme Information Documents (SID)**: Detailed scheme information
- **Key Information Memorandums (KIM)**: Summary documents
- **Factsheets**: Monthly performance data

Coverage: 50+ AMCs, 500+ schemes

## Cloud Deployment

The self-hosted BGE reranker removes per-query API charges but needs additional
memory and CPU/GPU capacity beyond the embedding-only deployment.

- Plan for at least 8GB RAM when serving both `bge-m3` and the 0.6B reranker on CPU
- Supabase/Neon free tier: pgvector database
- No reranking or generation-model API charges

See [deployment docs](docs/) for details.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | Compose-managed | PostgreSQL connection string inside the local network |
| `OLLAMA_BASE_URL` | Compose-managed | Ollama service URL inside the local network |
| `EMBEDDING_MODEL` | `bge-m3` | Embedding model |
| `RERANK_PROVIDER` | auto | `tei`, `bge`, `none`, or auto-enable when `RERANK_BASE_URL` is set |
| `RERANK_BASE_URL` | Compose-managed | Hugging Face TEI endpoint inside the local network |
| `RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Model identifier reported in retrieval traces |
| `RERANK_CANDIDATE_LIMIT` | `20` | Maximum fused chunks sent to the reranker |
| `ENABLE_RATE_LIMITING` | `false` | Enable API key limits |
| `MF_RAG_API_KEY` | required | Local server-side bearer credential; never commit or reuse in production |
| `AMC_SCOPE` | required | One canonical server-side tenant scope; for MCP retrieval only, reserved `RTA` retrieves every published `GLOBAL` or `TENANT` chunk when the credential has an `RTA` grant |
| `REVIEW_USERNAME` | - | Basic-auth username for the internal `/review` UI |
| `REVIEW_PASSWORD` | - | Basic-auth password for the internal `/review` UI |

## Security

The LLM-free architecture is inherently safer:

1. **No LLM to jailbreak**: Adversarial prompts have nothing to manipulate
2. **No content echoing**: Attack content never appears in output
3. **SQL injection safe**: Drizzle ORM uses parameterized queries
4. **Claude is the safety layer**: Claude's guardrails handle interpretation

See [security tests](scripts/test-jailbreak-direct.ts) for details.

## License

MIT
