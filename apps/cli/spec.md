# Feature: MF-RAG CLI (Phase 3.1)

## Problem Statement

Users need a command-line interface to query mutual fund documents, search for relevant chunks, and check system health without writing code.

## Requirements

### Functional Requirements

- [ ] FR-1: `query <question>` - Ask a question and get an answer with citations
- [ ] FR-2: `search <query>` - Search for relevant chunks without LLM generation
- [ ] FR-3: `status` - Check health of all services (Qdrant, Ollama, Postgres)
- [ ] FR-4: Support filters for fund name, scheme type, doc type
- [ ] FR-5: Output formats: text (default), json
- [ ] FR-6: Configurable service URLs via environment or flags

### Non-Functional Requirements

- [ ] NFR-1: Query response within 30 seconds
- [ ] NFR-2: Clear error messages for service failures
- [ ] NFR-3: Graceful handling of missing services

## CLI Interface

```bash
# Query (ask a question)
mf-rag query "What is the expense ratio of SBI Bluechip Fund?"
mf-rag query "What are the risk factors?" --fund "HDFC Equity"
mf-rag query "Investment objectives" --type Equity --limit 5
mf-rag query "..." --json  # JSON output

# Search (no LLM)
mf-rag search "expense ratio" --limit 10
mf-rag search "risk factors" --fund "SBI" --json

# Status
mf-rag status
mf-rag status --json
```

## Acceptance Criteria

### Query Command
```
Given a question "What is the expense ratio?"
When running `mf-rag query "What is the expense ratio?"`
Then output shows:
  - Answer text
  - Citations with fund name, doc type, pages, SEBI URL
  - Query metadata (time, chunks used)
```

### Search Command
```
Given a search term "expense ratio"
When running `mf-rag search "expense ratio" --limit 3`
Then output shows:
  - 3 search results
  - Each with: score, fund name, text snippet
```

### Status Command
```
When running `mf-rag status`
Then output shows:
  - Qdrant: OK/FAIL
  - Ollama: OK/FAIL
  - Postgres: OK/FAIL
  - Overall status
```

## Edge Cases

1. Empty query: Show error "Query cannot be empty"
2. Services unavailable: Show which service failed
3. No results: Show "No relevant documents found"
4. Invalid filter values: Show available options

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| QDRANT_URL | http://localhost:6333 | Qdrant server URL |
| OLLAMA_BASE_URL | http://localhost:11434 | Ollama server URL |
| DATABASE_URL | (from .env) | PostgreSQL connection |

## Output Formats

### Text (default)
```
Answer:
  [answer text]

Sources:
  [1] Fund Name (SID, p.25)
      https://sebi.gov.in/...
  [2] Fund Name (KIM, p.3)
      https://sebi.gov.in/...

Query completed in 3.2s (5 chunks used)
```

### JSON
```json
{
  "answer": "...",
  "citations": [...],
  "metadata": {...}
}
```
