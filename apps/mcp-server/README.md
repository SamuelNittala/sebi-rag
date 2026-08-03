# MF-RAG MCP Server

MCP (Model Context Protocol) server that allows Claude Desktop and Claude Code to query your mutual fund document database.

## Architecture: LLM-Free Design

This server does **NOT** use a local LLM for answer generation. Instead, it returns relevant document chunks directly to Claude, who synthesizes the answer.

```
Query → Embed (bge-m3) → Hybrid search → RRF → BGE rerank → Return chunks → Claude synthesizes
```

### Why No LLM?

| Aspect | With Local LLM | LLM-Free (this version) |
|--------|---------------|-------------------------|
| **Latency** | 8-16 seconds | Retrieval latency plus optional cross-encoder reranking |
| **Answer Quality** | qwen2.5:7b misses data | Claude parses tables correctly |
| **Security** | Small LLM can be jailbroken | No LLM to jailbreak |
| **Cost** | LLM inference cost | Self-hosted embedding and optional reranker inference |
| **Dependencies** | Ollama + LLM model | Ollama embedding + optional TEI reranker |

See [docs/direct-vs-rag-comparison.md](../../docs/direct-vs-rag-comparison.md) for detailed benchmarks.

## Tools Available

| Tool | Description |
|------|-------------|
| `query_mutual_funds` | Semantic search for MF documents, returns chunks for Claude |
| `search_mutual_fund_docs` | Lower-level search with excerpts |
| `list_schemes` | List all indexed mutual fund schemes |
| `check_status` | Check system health (pgvector, embedding service) |

## Setup

Local development, migrations, tests, and verification use Docker Compose only.
Do not run this server directly on the host or configure Claude Desktop or Claude
Code to spawn it from a local checkout. Follow the
[Docker-only local runbook](../../docs/runbooks/docker-local-development.md).

### Transport configuration

The Compose workflow runs the HTTP transport. Every HTTP consumer must follow
the protected bearer and static `X-AMC-Scope` contract in the
[investor-agent MCP transport contract](../../docs/contracts/investor-agent-mcp-transport.md).

Stdio is only for a trusted server-side deployment, not a local development
shortcut. Its protected environment must provide both `MF_RAG_API_KEY` and
`AMC_SCOPE`; startup fails closed if either is absent or unauthorized. Never
place these values in client-visible configuration, source control, or model
input.

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
| `DATABASE_URL` | Compose-managed | PostgreSQL connection string inside the local network |
| `OLLAMA_BASE_URL` | Compose-managed | Ollama service URL inside the local network |
| `EMBEDDING_MODEL` | `bge-m3` | Embedding model name |
| `RERANK_PROVIDER` | auto | `tei`, `bge`, `none`, or auto-enable when `RERANK_BASE_URL` is set |
| `RERANK_BASE_URL` | Compose-managed | Hugging Face TEI reranker endpoint |
| `RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Model identifier included in traces |
| `RERANK_CANDIDATE_LIMIT` | `20` | Maximum fused chunks sent to the reranker |
| `ENABLE_RATE_LIMITING` | `false` | Enable API key rate limiting |
| `MF_RAG_API_KEY` | required | Protected server-side bearer credential for HTTP and stdio authorization |
| `AMC_SCOPE` | required | Protected canonical tenant scope for HTTP and stdio authorization |

## Testing

Use the test and evaluation commands in the
[Docker-only local runbook](../../docs/runbooks/docker-local-development.md).

## Cloud Deployment

See the deployment plan for hosting on a $6-12/month VPS:
- Hetzner CX21 (4GB RAM) for Ollama + bge-m3
- Supabase/Neon free tier for pgvector
- No LLM costs (Claude handles generation)
