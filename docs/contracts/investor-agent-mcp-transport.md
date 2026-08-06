# Investor-agent MCP transport and FAQ citation contract

This contract is the production cutover prerequisite for every external MCP
client. It is additive to the existing scheme-document response contract.

## Request boundary

Every HTTP request to `/mcp` must send:

- `Authorization: Bearer <protected credential>`
- `X-AMC-Scope: <static canonical tenant ID>`
- the normal MCP JSON content type and accepted response types

Both values must come from protected deployment configuration. Investor or
model input must not select, replace, or forward the scope header. A key may
have several grants, but each deployment must inject exactly one configured
scope per request. `RTA` is the reserved regulator scope: after exact credential
authorization, it creates an explicit AMC-set repository capability for tenant
IDs `101`, `128`, `176`, `183`, `185`, and `RMF`.

Missing, repeated, comma-joined, malformed, or unauthorized scope values fail
before tool dispatch. There is no compatibility request without a scope and no
tool argument that can broaden the authorized repository capability. Ordinary
AMC scopes retrieve `GLOBAL` plus their matching tenant. The authorized `RTA`
scope retrieves published `GLOBAL` rows plus `TENANT` rows owned by `101`,
`128`, `176`, `183`, `185`, or `RMF`. It does not retrieve rows owned by any
other AMC or by the synthetic `RTA` tenant. Both modes exclude staged, retired, and
`UNCLASSIFIED` rows.

The additive `topic` input maps `general_mutual_fund` to published
`mutual_fund/general_mf_faq` evidence. `sif` preserves explicit SIF routing.
Omitted topics remain in the mutual-fund domain unless an explicit SIF or
scheme route is recognized. Scheme arguments never alter access scope.

## Additive response variant

Existing `scheme_document` chunks and `citations.scheme_documents` remain
supported. FAQ evidence uses `source_type: "generic_document"` and adds:

```json
{
  "documentTitle": "FAQs for Mutual Fund Investors",
  "publisher": "SEBI",
  "sourceUrl": "https://www.sebi.gov.in/.../faq.pdf",
  "sourceDate": "2024-09-25",
  "authority": "regulator",
  "pageNumbers": [4, 5],
  "topic": "SIP",
  "question": "How does a SIP work?",
  "questionNumber": null
}
```

The matching `citations.generic_documents[]` item uses `title`, `publisher`,
`sourceUrl`, nullable `sourceDate` and `authority`, `pageNumbers`, nullable
`question`, and nullable `topic`. Consumers must preserve distinct authorities
for conflicting answers and show the source date when present. They must not
assume generic documents contain scheme or AMC identifiers.

## Cutover checklist

- [x] RAG rejects missing or unauthorized credentials and scope.
- [x] In-repo review retrieval sends bearer and static `AMC_SCOPE`.
- [x] Scheme citations remain backward compatible.
- [x] Generic FAQ citations are additive and source-complete.
- [ ] Investor-agent sends the protected bearer and a deployment-static
  `X-AMC-Scope` on every MCP request.
- [ ] Investor-agent accepts and renders `generic_document` chunks and
  `citations.generic_documents`.
- [ ] Client parity is verified in a production-like environment.

Status: **UNMET — production activation remains blocked.** A rollback may
disable `/mcp` or restore a previously verified scoped build; it must never
restore an unscoped reader.
