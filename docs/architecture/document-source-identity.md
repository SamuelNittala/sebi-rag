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

For the Mirae SIF download catalogue, pin the catalogue page rather than its
current PDF URLs:

```yaml
discovery:
  strategy: mirae_sif_download_catalog
  catalogUrl: https://platinumsif.miraeassetmf.co.in/forms-downloads/forms
  sections: all
  additionalTargets:
    - section: regulatory
      subsection: total-expense-ratio
      endpoint: ter
  pageSize: 100
  maxPages: 500
  maxDocuments: 5000
  minimumDocuments: 40
```

Every successful run reads the section/subsection inventory advertised by the
page and exhausts each paginated catalogue endpoint. Exceptional API targets
that are absent from the side-link navigation are human-owned in
`additionalTargets`; their parent section must still be advertised by the page.
Identities are `catalog:<provider-id>`, so moving a document between navigation
sections does not rename it. Reusing one provider ID for different PDF URLs
fails the run as an identity conflict. A new provider ID creates a new logical
document; changed bytes behind an existing ID create an immutable version.
Unsupported non-PDF entries are not sent into the PDF pipeline. Missing or
malformed catalogue structure, exceeded safety limits, or fewer than the
reviewed `minimumDocuments` baseline fails the discovery run. The floor prevents
an empty or materially shrunken inventory from incrementing absence evidence;
operators still monitor document-count drift during rollout and scheduled soak.
