# Website document identity rules

Identity is configured in YAML and persisted in PostgreSQL. It is not derived from fetched bytes: bytes identify an immutable version, while the logical key identifies the document across versions and URL redirects.

For a small or important fixed set, pin a human key:

```yaml
discovery:
  strategy: explicit_urls
  urls:
    - key: platinum-hybrid-long-short-sid
      url: https://example.com/documents/current-sid.pdf
```

The configured URL remains canonical for that key. Same-host redirect targets are stored as aliases, so a CDN or route change does not rename the document.

For sitemap or crawl discovery, declare normalized-path identity and the query parameters that genuinely distinguish documents:

```yaml
discovery:
  strategy: sitemap
  sitemapUrls:
    - https://example.com/sitemap.xml
  includePathPrefixes: [/documents/]
  maxDocuments: 500
  identity:
    strategy: normalized_path
    queryParameters: [schemeCode]
```

The path remains visible in the logical key. Unlisted query parameters such as `utm_source` are removed from both identity and the persisted canonical URL. Listed parameters are sorted and represented by a short checksum suffix, avoiding credentials or volatile values in database identifiers. Changing the identity rule is a configuration migration and requires collision review before reconciliation.

Constrained crawl adds `maxDepth`, `maxPages`, and `maxDocuments`. It never leaves the start URL host, even when another host appears in the source-wide allowlist.
