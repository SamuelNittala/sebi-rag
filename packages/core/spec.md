# Feature: RAG Pipeline Core (Phase 2.1)

## Problem Statement

Users need to query mutual fund documents using natural language and receive accurate, cited answers. The system has 13,544 chunks indexed in Qdrant with BGE-M3 embeddings. We need a RAG pipeline that:
1. Embeds user queries
2. Retrieves relevant chunks
3. Assembles context within token limits
4. Generates responses using an LLM
5. Provides accurate citations to source documents

## Requirements

### Functional Requirements

- [ ] FR-1: Embed user queries using the same BGE-M3 model used during ingestion (1024 dimensions)
- [ ] FR-2: Retrieve relevant chunks from Qdrant with configurable limit and score threshold
- [ ] FR-3: Support filtering retrieval by fund name, AMC, scheme type, doc type, and date range
- [ ] FR-4: Assemble retrieved chunks into context that fits within token budget (default: 4000 tokens)
- [ ] FR-5: Deduplicate near-identical chunks from the same document
- [ ] FR-6: Generate responses using Ollama with Qwen 2.5 7B model
- [ ] FR-7: Include citations with document filename, fund name, page numbers, and relevance score
- [ ] FR-8: Return "I don't have information about this" when no relevant chunks are found
- [ ] FR-9: Support search-only mode (retrieval without LLM generation)
- [ ] FR-10: Health check for all dependent services (Qdrant, Ollama)

### Non-Functional Requirements

- [ ] NFR-1: Query latency < 5 seconds for typical queries (excluding cold start)
- [ ] NFR-2: Context assembly must not exceed configured token limit
- [ ] NFR-3: LLM temperature set to 0.3 for factual, consistent responses
- [ ] NFR-4: Graceful degradation when Ollama is unavailable (return search results only)

## Acceptance Criteria

### Query Flow
```
Given a user query "What is the expense ratio of SBI Bluechip Fund?"
When the query is processed through the RAG pipeline
Then the response should:
  - Contain an answer based on retrieved chunks
  - Include at least one citation with source document
  - Have metadata showing query time, chunks retrieved, and model used
```

### Search Flow
```
Given a search request "expense ratio"
When the search is processed
Then the response should:
  - Return up to `limit` results (default: 10)
  - Each result includes chunk text, score, and metadata
  - Results are sorted by relevance score descending
```

### Filter Flow
```
Given a query with filter { fundName: "SBI Bluechip Fund" }
When the query is processed
Then only chunks from SBI Bluechip Fund documents should be retrieved
```

### No Results Flow
```
Given a query about a non-existent fund "XYZ Fictional Fund"
When the query is processed
Then the response should indicate no relevant information was found
```

## Edge Cases

1. **Empty query**: Return error "Query cannot be empty"
2. **No matching chunks**: Return response stating no information found, with empty citations
3. **Low relevance scores**: If all scores < threshold (0.5), warn user about low confidence
4. **Ollama unavailable**: Return search results with error in metadata
5. **Very long query**: Truncate to reasonable length (1000 chars) before embedding
6. **Special characters**: Sanitize query but preserve search intent
7. **Multiple funds mentioned**: Include chunks from all mentioned funds, note in response

## Out of Scope

- Fund name detection/extraction from queries (Phase 2.2)
- Disambiguation prompts for ambiguous queries (Phase 2.3)
- SEBI URL citation tracking (Phase 2.4)
- Advanced re-ranking (Phase 2.5)
- Prompt optimization/fine-tuning (Phase 2.6)
- Streaming responses (future enhancement)
- Conversation history/multi-turn (future enhancement)

## Technical Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Native fetch for Ollama | Better control, Bun-native, matches existing embedder pattern | `ollama` npm package (extra dependency) |
| Separate service classes | Single responsibility, testable, composable for future phases | Monolithic RAGPipeline class |
| Token estimation via char/4 | Simple, fast, good enough for English text | Actual tokenizer (slow, complex) |
| Context limit 4000 tokens | Safe margin within Qwen's 8K window (leaves room for prompt + response) | Higher limits risk truncation |
| Temperature 0.3 | Balance between factual accuracy and natural language | 0.0 (too robotic), 0.7 (too creative) |
| Reuse existing embedder | Consistency with ingestion, no duplication | Duplicate code in packages/core |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          RAGPipeline                                  │
│                                                                       │
│  query(request) ──────────────────────────────────────────────────►  │
│       │                                                               │
│       ▼                                                               │
│  ┌─────────────┐    ┌───────────┐    ┌─────────────────┐             │
│  │ QueryEmbed  │───►│ Retriever │───►│ ContextAssembler│             │
│  └─────────────┘    └───────────┘    └─────────────────┘             │
│       │                   │                   │                       │
│       │                   │                   ▼                       │
│       │                   │          ┌───────────────┐                │
│       │                   │          │ PromptBuilder │                │
│       │                   │          └───────────────┘                │
│       │                   │                   │                       │
│       │                   │                   ▼                       │
│       │                   │          ┌───────────────┐                │
│       │                   │          │  OllamaClient │                │
│       │                   │          └───────────────┘                │
│       │                   │                   │                       │
│       ▼                   ▼                   ▼                       │
│  ◄────────────────── QueryResponse ──────────────────────────────────│
└──────────────────────────────────────────────────────────────────────┘
```

## Component Specifications

### OllamaClient
```typescript
interface LLMConfig {
  model: string;           // default: "qwen2.5:7b"
  baseUrl: string;         // default: "http://localhost:11434"
  temperature: number;     // default: 0.3
  maxTokens: number;       // default: 2048
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMResponse {
  content: string;
  model: string;
  totalDuration?: number;  // nanoseconds
  promptTokens?: number;
  completionTokens?: number;
}

class OllamaClient {
  constructor(config?: Partial<LLMConfig>)
  generate(messages: LLMMessage[]): Promise<LLMResponse>
  checkHealth(): Promise<boolean>
}
```

### ContextAssembler
```typescript
interface AssembledContext {
  chunks: RetrievedChunk[];     // Deduplicated, ordered
  totalTokens: number;
  uniqueFunds: string[];
  uniqueDocuments: string[];
  formattedContext: string;     // Ready for prompt insertion
}

interface RetrievedChunk {
  id: string;
  text: string;
  score: number;
  metadata: ChunkPayload;
  tokenEstimate: number;
  relevanceRank: number;
}

class ContextAssembler {
  assemble(chunks: SearchResult[], maxTokens: number): AssembledContext
}
```

### PromptBuilder
```typescript
class PromptBuilder {
  build(query: string, context: AssembledContext): LLMMessage[]
}
```

### RAGPipeline
```typescript
interface RAGPipelineConfig {
  ollama?: Partial<LLMConfig>;
  qdrant?: QdrantClientConfig;
  embedding?: Partial<EmbeddingConfig>;
  retrieval?: {
    limit?: number;           // default: 10
    scoreThreshold?: number;  // default: 0.5
  };
  context?: {
    maxTokens?: number;       // default: 4000
  };
}

class RAGPipeline {
  constructor(config?: Partial<RAGPipelineConfig>)
  query(request: QueryRequest): Promise<QueryResponse>
  search(request: SearchRequest): Promise<SearchResponse>
  checkHealth(): Promise<HealthResponse>
}
```

## File Structure

```
packages/core/src/
├── index.ts                    # Re-exports
├── llm/
│   ├── types.ts               # LLMConfig, LLMMessage, LLMResponse
│   ├── index.ts               # OllamaClient class
│   └── index.test.ts          # Unit tests
├── context/
│   ├── index.ts               # ContextAssembler class
│   └── index.test.ts          # Unit tests
├── prompt/
│   ├── index.ts               # PromptBuilder class
│   └── index.test.ts          # Unit tests
├── retrieval/
│   ├── index.ts               # Retriever class (wraps Qdrant)
│   └── index.test.ts          # Unit tests
├── embedding/
│   └── index.ts               # Re-export from ingestion embedder
└── rag/
    ├── index.ts               # RAGPipeline orchestrator
    └── index.test.ts          # Integration tests
```

## Dependencies

Existing (no new packages needed):
- `@mf-rag/types` - Query/response types
- `@mf-rag/vector` - Qdrant client
- `@mf-rag/db` - Document metadata

Reuse from ingestion:
- `apps/ingestion/src/embedding/embedder.ts` - Embedding functions

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| OLLAMA_BASE_URL | http://localhost:11434 | Ollama API URL |
| QDRANT_URL | http://localhost:6333 | Qdrant API URL |
| LLM_MODEL | qwen2.5:7b | LLM model name |
| LLM_TEMPERATURE | 0.3 | Generation temperature |
| RAG_CHUNK_LIMIT | 10 | Max chunks to retrieve |
| RAG_SCORE_THRESHOLD | 0.5 | Min similarity score |
| RAG_CONTEXT_MAX_TOKENS | 4000 | Max context tokens |

## Testing Strategy

### Unit Tests (mocked dependencies)
- OllamaClient: Mock fetch, verify request format
- ContextAssembler: Various chunk combinations, deduplication
- PromptBuilder: Verify prompt structure

### Integration Tests (real services)
- Full pipeline with Qdrant and Ollama
- Test queries against actual indexed data
- Verify citation accuracy

### Test Queries
1. Factual: "What is the expense ratio of SBI Bluechip Fund?"
2. Comparison: "Compare investment objectives of equity funds"
3. Filtered: "What are the risk factors for debt funds?"
4. No match: "What is the NAV of XYZ Fund?" (should say "don't know")
5. Edge: Empty query, very long query, special characters
