# MF-RAG MCP Server

MCP (Model Context Protocol) server that allows Claude Desktop and Claude Code to query your mutual fund document database.

## Architecture: LLM-Free Design

This server does **NOT** use a local LLM for answer generation. Instead, it returns relevant document chunks directly to Claude, who synthesizes the answer.

```
Query → Embed (bge-m3) → Vector Search (pgvector) → Return chunks → Claude synthesizes
```

### Why No LLM?

| Aspect | With Local LLM | LLM-Free (this version) |
|--------|---------------|-------------------------|
| **Latency** | 8-16 seconds | 300-500ms |
| **Answer Quality** | qwen2.5:7b misses data | Claude parses tables correctly |
| **Security** | Small LLM can be jailbroken | No LLM to jailbreak |
| **Cost** | LLM inference cost | Embedding only |
| **Dependencies** | Ollama + LLM model | Ollama + embedding model |

See [docs/direct-vs-rag-comparison.md](../../docs/direct-vs-rag-comparison.md) for detailed benchmarks.

## Tools Available

| Tool | Description |
|------|-------------|
| `query_mutual_funds` | Semantic search for MF documents, returns chunks for Claude |
| `search_mutual_fund_docs` | Lower-level search with excerpts |
| `list_schemes` | List all indexed mutual fund schemes |
| `check_status` | Check system health (pgvector, embedding service) |

## Setup

### Prerequisites

1. **PostgreSQL with pgvector:**
   ```bash
   docker compose -f docker/docker-compose.yml up -d
   ```

2. **Ollama with bge-m3 embedding model:**
   ```bash
   ollama pull bge-m3
   ollama list  # Should show bge-m3
   ```

   Note: No LLM model (like qwen2.5:7b) is required.

### Claude Desktop Configuration

Edit `~/.config/claude/claude_desktop_config.json` (Linux) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

Then restart Claude Desktop.

### Claude Code Configuration

Add to your project's `.mcp.json`:

```json
{
  "servers": {
    "mf-rag": {
      "command": "bun",
      "args": ["run", "apps/mcp-server/src/index.ts"]
    }
  }
}
```

## Example Conversations

Once connected, you can ask Claude:

- "What mutual fund schemes do you have access to?"
- "What is the expense ratio of HDFC Focused 30 Fund?"
- "Compare the investment objectives of Axis Value Fund and Parag Parikh Flexi Cap Fund"
- "Which equity funds have the lowest expense ratios?"
- "What are the risk factors for debt funds?"

Claude will use the `query_mutual_funds` tool to retrieve relevant document chunks, then synthesize an answer with proper citations.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `EMBEDDING_MODEL` | `bge-m3` | Embedding model name |
| `ENABLE_RATE_LIMITING` | `false` | Enable API key rate limiting |
| `MF_RAG_API_KEY` | - | API key for rate limiting |

## Rate Limiting (Optional)

For cloud deployments, enable rate limiting:

```json
{
  "env": {
    "ENABLE_RATE_LIMITING": "true",
    "MF_RAG_API_KEY": "mf_free_xxxxx"
  }
}
```

Limits:
- Free tier: 10 queries/minute, 100/day, 1000/month
- Pro tier: 100 queries/minute, 10000/day, unlimited/month

## Testing

```bash
# Run server directly (communicates via stdio)
bun run apps/mcp-server/src/index.ts

# Test embedding + search
bun scripts/compare-direct-vs-rag.ts "What is the expense ratio?"
```

## Cloud Deployment

See the deployment plan for hosting on a $6-12/month VPS:
- Hetzner CX21 (4GB RAM) for Ollama + bge-m3
- Supabase/Neon free tier for pgvector
- No LLM costs (Claude handles generation)
