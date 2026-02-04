# Qdrant vs pgvector: Comparison for MF PDF RAG

## Executive Summary

**Recommendation: Migrate to pgvector**

Your current Qdrant usage is basic (vector search + payload filtering). pgvector can handle this with less operational overhead since you already use PostgreSQL for metadata. The advanced Qdrant features (sparse vectors, hybrid search, quantization) are not being used.

---

## Current Qdrant Usage Analysis

| Feature | Currently Used | pgvector Support |
|---------|---------------|------------------|
| Vector storage (1024 dim) | Yes | Yes |
| Cosine similarity search | Yes | Yes |
| Payload/metadata filtering | Yes | Yes (via SQL WHERE) |
| Batch upserts | Yes | Yes (COPY/bulk INSERT) |
| Document-level deletion | Yes | Yes (DELETE WHERE) |
| Scroll/pagination | Yes | Yes (OFFSET/LIMIT, cursors) |
| Payload indexing | Yes | Yes (B-tree, GIN indexes) |

**Not used:** Sparse vectors, hybrid search, quantization, RRF, custom scoring, batch search.

---

## Feature Comparison

### Vector Operations

| Capability | Qdrant | pgvector |
|------------|--------|----------|
| Max dimensions | Unlimited | 2000 (16000 in v0.8+) |
| Distance metrics | Cosine, Dot, Euclidean, Manhattan | Cosine, Dot, Euclidean (L1 in v0.8+) |
| Approximate search (ANN) | HNSW | HNSW, IVFFlat |
| Exact search | Yes | Yes |
| Sparse vectors | Yes | No (use tsvector for BM25) |
| Binary vectors | Yes | Yes (bit type) |
| Quantization | Scalar, Product, Binary | Half-precision (halfvec in v0.7+) |

**Your use case:** 1024 dimensions with cosine similarity. Both handle this well.

### Filtering

| Capability | Qdrant | pgvector |
|------------|--------|----------|
| Exact match | Yes | Yes (WHERE =) |
| Range queries | Yes | Yes (WHERE BETWEEN) |
| Full-text search | No (payload only) | Yes (tsvector + GIN) |
| JSON filtering | Yes | Yes (JSONB + GIN) |
| Composite filters | AND, OR, nested | Full SQL (AND, OR, NOT, subqueries) |
| Pre-filtering | Yes | Yes (with proper indexes) |
| Post-filtering | Yes | Yes |

**Your use case:** Simple AND filters on keyword fields. pgvector wins here - SQL is more expressive and familiar.

### Indexing

| Capability | Qdrant | pgvector |
|------------|--------|----------|
| HNSW parameters | m, ef_construct | m, ef_construction |
| Index build | Background | Foreground (blocks writes) |
| Partial indexes | No | Yes |
| Concurrent builds | No | Yes (CREATE INDEX CONCURRENTLY) |
| Index size control | Quantization | halfvec, fewer dimensions |

**Your use case:** ~53 PDFs, likely <100k chunks. Both handle this easily. pgvector's concurrent index builds are better for production.

### Operations

| Capability | Qdrant | pgvector |
|------------|--------|----------|
| Backup/restore | Snapshots | pg_dump, PITR |
| Replication | Raft (distributed) | PostgreSQL streaming |
| Scaling | Sharding built-in | Read replicas, partitioning |
| Monitoring | REST API, Prometheus | pg_stat, standard PostgreSQL |
| Updates | Collection recreation | ALTER TABLE, migrations |

**Your use case:** Single-node deployment. pgvector wins - you already have PostgreSQL operational knowledge.

---

## Performance Comparison

### Search Latency (approximate, depends on hardware)

| Dataset Size | Qdrant | pgvector (HNSW) |
|--------------|--------|-----------------|
| 10k vectors | <5ms | <5ms |
| 100k vectors | <10ms | <10ms |
| 1M vectors | <20ms | <30ms |
| 10M vectors | <50ms | 50-100ms |

**Your use case:** With ~53 PDFs and typical chunking, you have <50k vectors. Both are effectively instant.

### Filtering Performance

| Scenario | Qdrant | pgvector |
|----------|--------|----------|
| No filter | Equal | Equal |
| Selective filter (1%) | Qdrant slightly faster | Good with proper indexes |
| Broad filter (50%+) | Equal | Equal |
| Complex multi-field | Qdrant optimized | Depends on query planner |

**Your use case:** Simple filters on indexed fields. Both perform well.

### Memory Usage

| Aspect | Qdrant | pgvector |
|--------|--------|----------|
| Base overhead | ~200MB | Shared with PostgreSQL |
| Per vector (1024 dim, float32) | ~4KB | ~4KB |
| HNSW index overhead | ~1.5x vectors | ~1.5x vectors |
| Payload storage | Separate | Same table (shared buffers) |

**Your use case:** pgvector has lower total memory since it shares PostgreSQL's buffer pool.

---

## Operational Complexity

### Qdrant
- Separate service to deploy, monitor, backup
- Separate connection pool management
- Different query language (Qdrant API vs SQL)
- Version upgrades independent of PostgreSQL
- Cloud option (Qdrant Cloud) available

### pgvector
- Extension in existing PostgreSQL
- Single backup strategy
- Standard SQL queries
- Upgrades with PostgreSQL
- Available on all managed PostgreSQL (Supabase, Neon, RDS, etc.)

**Winner: pgvector** - One less service to manage.

---

## Migration Effort

### What Changes

```
Current (Qdrant):
┌─────────────┐     ┌─────────────┐
│ PostgreSQL  │     │   Qdrant    │
│ (metadata)  │     │  (vectors)  │
└─────────────┘     └─────────────┘

After (pgvector):
┌─────────────────────────────────┐
│          PostgreSQL             │
│   (metadata + vectors)          │
└─────────────────────────────────┘
```

### Schema Migration

```sql
-- Enable extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add vector column to existing chunks table (or create new)
ALTER TABLE chunks ADD COLUMN embedding vector(1024);

-- Create HNSW index
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Create indexes for filtering (if not exists)
CREATE INDEX ON chunks (fund_name);
CREATE INDEX ON chunks (amc_name);
CREATE INDEX ON chunks (scheme_type);
CREATE INDEX ON chunks (doc_type);
```

### Code Changes

| Component | Effort |
|-----------|--------|
| packages/vector | Rewrite (~300 lines) |
| packages/core/src/rag | Minor changes to search calls |
| apps/mcp-server | No changes (uses core) |
| apps/ingestion | Minor changes to upsert calls |

**Estimated effort:** 1-2 days for a clean migration.

### Query Translation

**Qdrant:**
```typescript
await qdrant.search("mf_chunks", {
  vector: queryEmbedding,
  limit: 10,
  filter: {
    must: [
      { key: "fund_name", match: { value: "HDFC" } },
      { key: "doc_type", match: { value: "SID" } }
    ]
  }
});
```

**pgvector:**
```sql
SELECT *, 1 - (embedding <=> $1) AS score
FROM chunks
WHERE fund_name = 'HDFC' AND doc_type = 'SID'
ORDER BY embedding <=> $1
LIMIT 10;
```

---

## When to Keep Qdrant

Choose Qdrant if you need:

1. **Sparse vectors / hybrid search** - BM25 + dense vectors with RRF fusion
2. **Massive scale** - 100M+ vectors with automatic sharding
3. **Multi-tenancy** - Isolated collections per tenant
4. **Real-time updates at scale** - High write throughput with immediate consistency
5. **Quantization** - Significant memory reduction for large datasets
6. **Distributed deployment** - Built-in Raft consensus, no external orchestration

---

## When to Use pgvector

Choose pgvector if you:

1. **Already use PostgreSQL** - Single database, simpler ops
2. **Have <10M vectors** - pgvector handles this well
3. **Need SQL joins** - Combine vector search with relational queries
4. **Want simpler deployments** - One service instead of two
5. **Use managed PostgreSQL** - pgvector available on most providers
6. **Prefer SQL** - Familiar query language, better tooling

---

## Cost Comparison

### Self-hosted (your current setup)

| Resource | Qdrant | pgvector |
|----------|--------|----------|
| Memory | +200MB base | Shared |
| Storage | Separate volume | Shared |
| CPU | Separate process | Shared |
| Backup storage | Separate snapshots | Single pg_dump |

**pgvector is cheaper** - no additional resources.

### Cloud (if you move to managed)

| Provider | Qdrant Cloud | pgvector (managed PG) |
|----------|--------------|----------------------|
| Starter | $25/mo (1M vectors) | Included in PG |
| Production | $100+/mo | Included in PG |

**pgvector is significantly cheaper** - it's just a PostgreSQL extension.

---

## Recommendation for MF PDF RAG

### Migrate to pgvector because:

1. **You're not using Qdrant-specific features** - No sparse vectors, hybrid search, or quantization
2. **Small dataset** - ~50k chunks is trivial for pgvector
3. **Already have PostgreSQL** - metadata tables exist, just add vectors
4. **Simpler operations** - One database to backup, monitor, scale
5. **Better filtering** - SQL is more expressive than Qdrant's filter syntax
6. **Cost savings** - One less service to run

### Keep Qdrant if:

1. You plan to add hybrid search (BM25 + semantic)
2. You expect 10M+ vectors in the future
3. You need multi-tenant isolation
4. You want Qdrant Cloud's managed offering

---

## Migration Checklist

- [ ] Enable pgvector extension in PostgreSQL
- [ ] Create chunks table with vector column (or add column)
- [ ] Create HNSW index on embedding column
- [ ] Create B-tree indexes on filter columns
- [ ] Rewrite packages/vector to use SQL
- [ ] Update packages/core/src/rag search calls
- [ ] Migrate existing vectors (export from Qdrant, import to PG)
- [ ] Update docker-compose to remove Qdrant
- [ ] Update environment variables
- [ ] Run integration tests
- [ ] Remove Qdrant dependencies from package.json

---

## References

- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [pgvector 0.8 release notes](https://github.com/pgvector/pgvector/releases/tag/v0.8.0)
- [Qdrant documentation](https://qdrant.tech/documentation/)
- [Supabase pgvector guide](https://supabase.com/docs/guides/ai/vector-columns)
- [pgvector vs Qdrant benchmark](https://qdrant.tech/benchmarks/)
