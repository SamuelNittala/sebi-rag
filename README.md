# MF-RAG: Mutual Fund Document Search for Claude

An MCP server that lets Claude Desktop and Claude Code answer questions about
Indian mutual funds from official documents: SEBI scheme documents, AMC
factsheets, and AMFI investor education pages.

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

The local LLM (qwen2.5:7b) failed to extract expense ratios from tables that
were right in its context. Claude handles this correctly.

## Features

- **Hybrid search**: dense (`bge-m3`) and keyword (BM25) retrieval, fused with
  reciprocal rank fusion and reranked by `BAAI/bge-reranker-v2-m3`
- **Layout-aware PDF parsing**: a Python [Docling](https://github.com/docling-project/docling)
  service turns factsheets and scheme documents into clean chunks, including
  tables, charts, and multi-fund pages
- **Document types**: SID, KIM, factsheets, and HTML investor-education pages
- **Filters**: by fund name, AMC, scheme type, and document type
- **Citations**: every result carries its source document, page numbers, and URL
- **Chunk review before publishing**: nothing reaches search until it passes
  automated checks and, where flagged, a human review
- **Per-AMC access scopes**: each credential can only read the documents its
  scope allows

## Quick Start

Local development runs entirely in Docker Compose.

```bash
cp .env.example .env
# Fill in the local credential, AMC scope, and review login placeholders.
docker compose --env-file .env -f docker/docker-compose.dev.yml up -d --build --wait
```

Open <http://127.0.0.1:3000/review>. The
[local development guide](docs/runbooks/docker-local-development.md) covers
migrations, tests, ingestion, review publication, evaluation, and reset.

To run the Docling parse service as well:

```bash
docker compose --env-file .env -f docker/docker-compose.dev.yml --profile docling up -d docling
```

### Authentication

Every MCP client sends a bearer credential and exactly one `X-AMC-Scope`
header. Requests without a scope are rejected; there is no unscoped fallback.

## Example Queries

- "What mutual fund schemes do you have access to?"
- "Compare the expense ratios of HDFC and ICICI equity funds"
- "What are the risk factors for debt mutual funds?"
- "Which funds have the lowest expense ratios?"
- "What is the investment objective of Axis Bluechip Fund?"

## Architecture

### Ingestion

```
Source connectors ──▶ Fetch ──▶ Parse ──────────────▶ Chunk + inspect ──▶ Review ──▶ Publish
(SEBI, AMC sites,              (Docling service,       (automated checks)  (UI)      (embed into
 AMFI pages)                    Python, HTTP)                                         pgvector)
```

The pipeline (`apps/pipeline`) runs as a scheduler plus workers that claim
stages from PostgreSQL. PDFs go to the Docling service over a versioned HTTP
contract; it returns structured chunks with page positions. Flagged chunks are
held for review, and only `published` chunks are searchable.

### Retrieval

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
                │    (bge-m3)     │ │ bge-reranker-v2-m3 │
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
sebi-rag/
├── apps/
│   ├── mcp-server/        # MCP server (main entry point)
│   ├── pipeline/          # Document pipeline: discover, fetch, parse, inspect, publish
│   ├── ingestion/         # Chunking and HTML ingestion
│   ├── scraper/           # SEBI, AMFI, and AMC source scrapers
│   ├── api/               # Review API and UI (chunks drawn over the source PDF page)
│   └── cli/               # Command-line interface
├── packages/
│   ├── core/              # Shared logic: embedding, chunk inspection, rate limiting
│   ├── db/                # Drizzle ORM schema and migrations
│   ├── vector/            # pgvector client and hybrid search
│   └── types/             # Shared TypeScript types
├── python/
│   ├── docling_service/   # Docling PDF parse service (Flask + gunicorn, pytest)
│   └── table_extractor/   # Standalone table extraction helper
├── config/access-scopes/  # Per-AMC source allowlists
├── data/                  # HTML sources and sample PDFs
├── tests/                 # Unit, integration, retrieval, and parser fixtures
├── scripts/               # Utility and evaluation scripts
└── docker/                # Compose files and the Docling image
```

## Development

Use the commands in the
[local development guide](docs/runbooks/docker-local-development.md). The
one-shot `runner` service runs repository commands inside the same image and
network as PostgreSQL, Redis, embeddings, reranking, MCP, and review.

- TypeScript tests: `bun test`
- Docling service tests: `pytest` in `python/docling_service`

### Pre-embedding chunk review

PDF and HTML ingestion stop after automated inspection by default. Candidate
chunks and their findings are stored outside the searchable set, so a malformed
chunk cannot reach retrieval before review.

The review screen shows every flagged chunk for a document on one page, with
the neighbouring chunks, the source page with the chunk outlined on it, the
inferred scope, the rule that flagged it, and an audit-logged reviewer
decision. Use **Edit all candidate chunks** to correct extracted text before
approval. Each save needs a reason, records the full before/after revision, and
re-inspects the whole document, because an edit can shift neighbouring chunk
boundaries. Retrieval reads only `published` rows; staged and retired versions
are excluded.

## Data Sources

- **[SEBI](https://www.sebi.gov.in/)**: Scheme Information Documents (SID) and
  Key Information Memorandums (KIM)
- **AMC websites**: monthly factsheets and scheme pages
- **[AMFI](https://www.amfiindia.com/)**: investor centre and knowledge centre pages

## Resource Requirements

The self-hosted models remove per-query API charges but need memory and CPU:

- At least 8GB RAM to serve `bge-m3` and the reranker on CPU
- The Docling service is limited to 6GB RAM and 4 CPUs in the dev compose file
- Any PostgreSQL with pgvector works for the database

## Environment Variables

See `.env.example` for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | Compose-managed | PostgreSQL connection string inside the local network |
| `OLLAMA_BASE_URL` | Compose-managed | Ollama service URL inside the local network |
| `EMBEDDING_MODEL` | `bge-m3` | Embedding model |
| `RERANK_PROVIDER` | auto | `tei`, `bge`, `none`, or auto-enable when `RERANK_BASE_URL` is set |
| `RERANK_BASE_URL` | Compose-managed | Hugging Face TEI endpoint inside the local network |
| `RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Model identifier reported in retrieval traces |
| `RERANK_CANDIDATE_LIMIT` | `20` | Maximum fused chunks sent to the reranker |
| `PIPELINE_DOCLING_SERVICE_URL` | empty | Docling service URL; `http://docling:8090` when running it locally |
| `ENABLE_RATE_LIMITING` | `false` | Enable API key limits |
| `MF_RAG_API_KEY` | required | Server-side bearer credential; never commit it |
| `AMC_SCOPE` | required | The one AMC scope this server reads. The reserved `RTA` scope can read all published content |
| `REVIEW_USERNAME` | - | Basic-auth username for the `/review` UI |
| `REVIEW_PASSWORD` | - | Basic-auth password for the `/review` UI |

## Security

The LLM-free design is safer by construction:

1. **No LLM to jailbreak**: adversarial prompts have nothing to manipulate
2. **No content echoing**: attack content never appears in output
3. **SQL injection safe**: Drizzle ORM uses parameterized queries
4. **Claude is the safety layer**: Claude's guardrails handle interpretation

See the [jailbreak tests](scripts/test-jailbreak-direct.ts) for details.

## License

MIT — see [LICENSE](LICENSE).
