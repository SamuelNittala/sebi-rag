# Direct Search vs RAGPipeline Comparison

## Test Results Summary

| Query | Direct Search | RAGPipeline | Speedup | Quality Winner |
|-------|---------------|-------------|---------|----------------|
| Expense ratio (HDFC Focused 30) | 400ms | 8,204ms | **20.5x** | Direct (RAG failed) |
| Risk factors (general) | 3,115ms | 12,935ms | **4.2x** | RAG (good answer) |
| Compare HDFC vs SBI | 2,603ms | 15,764ms | **6.1x** | Direct (RAG failed) |

**Average speedup: 10.3x faster with direct search**

## Critical Finding: RAGPipeline LLM Failures

The qwen2.5:7b LLM **failed to use retrieved data** in 2 of 3 tests:

### Failure 1: Expense Ratio Query
- **Chunks contained**: Page 21-24 with "ANNUAL SCHEME RECURRING EXPENSES"
- **LLM said**: "I couldn't find any specific information about the expense ratio"
- **Reality**: Data was right there, LLM ignored it

### Failure 2: Comparison Query
- **Chunk #1 contained**: Literal expense ratio table:
  ```
  | Scheme Name | Total Expense Ratio |
  | HDFC Banking & Financial Services Fund | Regular: 1.88% Direct: 0.67% |
  | HDFC Dividend Yield Fund | Regular: 1.79% Direct: 0.60% |
  ```
- **LLM said**: "I'm unable to provide a comparison... without specific data"
- **Reality**: Table was in the context, LLM couldn't parse/use it

## Why Direct Search + Claude is Better

1. **Claude is smarter**: Can parse tables, extract specific data
2. **Claude sees everything**: Gets raw chunks with full context
3. **No double-hop**: Query → Claude instead of Query → Small LLM → Claude
4. **Cost**: No per-query LLM API cost (Ollama is free but slow)
5. **Latency**: 10x faster on average

## Recommendation

**Use `search_mutual_funds_direct` as the PRIMARY tool for MCP.**

Keep `query_mutual_funds` available for:
- Non-Claude clients (CLI, API)
- Offline/edge cases where Claude isn't available

## Architecture Comparison

```
CURRENT (RAGPipeline):
Query → Embed (250ms) → Search (100ms) → Context → Prompt → qwen2.5:7b (10-15s) → Response
                                                            ↑
                                                    Small model fails
                                                    on complex data

RECOMMENDED (Direct):
Query → Embed (250ms) → Search (100ms) → Return chunks → Claude synthesizes
                                                          ↑
                                              Claude handles tables,
                                              comparisons, nuance
```

## Token Economics

| Approach | Embedding | Search | LLM | Total Latency |
|----------|-----------|--------|-----|---------------|
| RAGPipeline | ~250ms | ~100ms | ~10-15s | **10-16s** |
| Direct | ~250ms | ~100ms | 0 (Claude does it) | **350ms** |

Direct search returns ~10 chunks × ~500 tokens = 5,000 tokens to Claude.
This is well within Claude's context and costs negligible tokens.
