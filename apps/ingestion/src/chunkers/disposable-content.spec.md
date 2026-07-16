# Feature: Platinum SIF SAI Content Curation

## Problem Statement

The Platinum SIF SAI contains useful SIF-wide legal and operational information alongside covers,
contents pages, AMC biographies, a generic personnel directory, historical associate tables, and
worked examples. Indexing every page as strategy content creates retrieval conflicts, including the
incorrect selection of an ETF manager for a Platinum strategy fund-manager question.

## Requirements

### Functional

- [x] FR-1: Exclude SAI PDF pages 1-2, 4-5, 11-13, 20-32, 116, 122, 127, and 133-134.
- [x] FR-2: Preserve useful content from mixed pages 6, 14, 33, 35, 68, 115, 117, 123, 130, 131, and 138 while removing their audited disposable sections.
- [x] FR-3: Recompute token counts and contiguous chunk indexes after trimming or removal.
- [x] FR-4: Apply these rules only to `SAI-SIF_March-2026.pdf`; existing KIM and form rules must remain unchanged.
- [x] FR-5: Classify retained Mirae SIF SAI candidates as `sif_umbrella` and assign no strategy ID.
- [x] FR-6: Preserve page references on retained chunks for reviewer verification.

### Non-Functional

- [x] NFR-1: Filtering must be deterministic and require no network or model call.
- [x] NFR-2: Mixed-page rules must retain the useful side when both useful and disposable text occur in one chunk.
- [x] NFR-3: The existing published SAI version must remain active until the curated run is reviewed and published.

## Acceptance Criteria

- Given a chunk wholly within an audited full-page exclusion, it is removed.
- Given a chunk spanning an excluded and retained page, it is not removed solely because one page is excluded.
- Given page 33 personnel text followed by `III. Service providers`, only the service-provider text remains.
- Given pages 115-117 associate tables followed by `Mode of Holding`, the historical tables are removed and `Mode of Holding` remains.
- Given a Mirae SIF SAI document, its candidates have `documentScope=sif_umbrella` and `strategyId=null`.
- Given another SIF PDF, its content is unaffected by the SAI-specific rules.

## Edge Cases

1. A mixed-page marker is absent: retain the chunk unless it is wholly within a full-page exclusion.
2. Trimming produces empty text: remove the chunk.
3. A chunk spans multiple pages: discard it by page only when every referenced page is excluded.

## Out of Scope

- Publishing or approving the curated SAI run.
- Rewriting the source PDF.
- Removing retained tax, KYC, valuation, legal, or disclosure content.

## Technical Decisions

| Decision | Rationale | Alternatives Considered |
|---|---|---|
| Curate after semantic chunking | Existing chunks retain page references and section text needed for deterministic rules | Rewriting the PDF |
| Use exact filename and audited markers | Prevents rules leaking to unrelated SAI versions or documents | Broad keyword filtering |
| Use `sif_umbrella` with no strategy ID | Accurately represents SIF-wide content and avoids strategy-level authority | Keeping the existing `amc` scope |
