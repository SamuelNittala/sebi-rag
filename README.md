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
Query → Embed → Search → Return chunks → Claude synthesizes
                                             ↓
                                     Fast, accurate, safe
```

### Comparison

| Metric | With Local LLM | LLM-Free |
|--------|----------------|----------|
| **Latency** | 8-16 seconds | 300-500ms |
| **Accuracy** | Misses table data | Parses tables correctly |
| **Security** | Can be jailbroken | No LLM to jailbreak |
| **Cost** | LLM inference | Embedding only |

The local LLM (qwen2.5:7b) failed to extract expense ratios from tables that were right in its context. Claude handles this correctly.

## Features

- **Semantic search** across 500+ mutual fund schemes
- **Document types**: SID, KIM, Factsheets from SEBI
- **Filters**: By fund name, AMC, scheme type, document type
- **Citations**: Every answer includes source documents with page numbers and SEBI URLs
- **Rate limiting**: Optional API key-based limits for cloud deployment

## Quick Start

### Prerequisites

```bash
# PostgreSQL with pgvector
docker compose -f docker/docker-compose.yml up -d

# Ollama with embedding model (no LLM needed!)
ollama pull bge-m3
```

### Configure Claude Desktop

Edit `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mf-rag": {
      "command": "bun",
      "args": ["run", "/path/to/mf-pdf-rag/apps/mcp-server/src/index.ts"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/mf_rag",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

Restart Claude Desktop, then ask:

> "What is the expense ratio of HDFC Focused 30 Fund?"

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
                                 ▼
                        ┌─────────────────┐
                        │     Ollama      │
                        │    (bge-m3)     │
                        │  Embedding Only │
                        └─────────────────┘
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

```bash
# Install dependencies
bun install

# Start PostgreSQL
docker compose -f docker/docker-compose.yml up -d

# Run migrations
bun run --filter=@mf-rag/db migrate

# Start MCP server (for testing)
bun run apps/mcp-server/src/index.ts

# Run comparison tests
bun scripts/compare-direct-vs-rag.ts "What is the expense ratio?"

# Run jailbreak tests
bun scripts/test-jailbreak-direct.ts
```

## Data Source

Official mutual fund documents from [SEBI](https://www.sebi.gov.in/) (Securities and Exchange Board of India):

- **Scheme Information Documents (SID)**: Detailed scheme information
- **Key Information Memorandums (KIM)**: Summary documents
- **Factsheets**: Monthly performance data

Coverage: 50+ AMCs, 500+ schemes

## Cloud Deployment

Estimated cost: **$6-12/month**

- Hetzner CX21 (4GB RAM): $6-12/mo for Ollama + bge-m3
- Supabase/Neon free tier: pgvector database
- No LLM API costs (Claude handles generation)

See [deployment docs](docs/) for details.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_MODEL` | `bge-m3` | Embedding model |
| `ENABLE_RATE_LIMITING` | `false` | Enable API key limits |
| `MF_RAG_API_KEY` | - | API key for rate limiting |

## Security

The LLM-free architecture is inherently safer:

1. **No LLM to jailbreak**: Adversarial prompts have nothing to manipulate
2. **No content echoing**: Attack content never appears in output
3. **SQL injection safe**: Drizzle ORM uses parameterized queries
4. **Claude is the safety layer**: Claude's guardrails handle interpretation

See [security tests](scripts/test-jailbreak-direct.ts) for details.

## License

MIT
