# Feature: Chunk Inspection and Human Review

## Problem Statement

Parsed document text can lose layout relationships before embedding. A malformed
chunk can therefore look semantically relevant while representing the wrong
fact. Every candidate chunk must be inspected and reviewable before it becomes a
production vector.

## Functional Requirements

- [x] FR-1: Inspect every candidate chunk in a document exactly once per
  inspector version.
- [x] FR-2: Inspectors may use the previous and next candidate to detect broken
  cross-chunk structures.
- [x] FR-3: Return deterministic findings with a rule code, severity, message,
  evidence, and approval-blocking decision.
- [x] FR-4: Persist review runs, candidate chunks, findings, reviewer decisions,
  and an immutable audit trail before embedding.
- [x] FR-5: A review run cannot be approved while a blocking finding is open.
- [x] FR-6: A review run cannot be approved unless its inspected chunk count
  equals its candidate chunk count.
- [x] FR-7: Reviewers can list documents and see all flagged chunks for one
  document, including adjacent chunk context.
- [x] FR-8: Reviewers can accept a finding as a false positive, resolve it, or
  reject/approve the whole review run with a note.
- [x] FR-9: PDF and HTML ingestion can stage review candidates and stop before
  embedding when review is required.
- [x] FR-10: A reviewer can edit the text of any candidate chunk while its run
  is `review_ready`, with a mandatory reason.
- [x] FR-11: Saving an edit reinspects every candidate in the document so
  cross-chunk findings reflect the new boundaries.
- [x] FR-12: Every edit preserves the before/after text, content hashes,
  reviewer, note, and timestamp in an append-only audit record.
- [x] FR-13: An edit invalidates prior flag decisions and replaces findings with
  a fresh open set from the current inspector version.

## Non-Functional Requirements

- [x] NFR-1: Inspection is deterministic and idempotent for the same inspector
  version and candidate content.
- [x] NFR-2: Review mutations are authenticated and audit logged.
- [x] NFR-3: A failed review run does not modify existing production chunks.
- [x] NFR-4: The document review screen renders up to 1,000 flagged chunks
  without requiring one-page-per-chunk navigation.
- [x] NFR-5: Rule identifiers and inspector versions are stored so historical
  decisions remain explainable.
- [x] NFR-6: Concurrent edits use the candidate content hash as an optimistic
  lock so one reviewer cannot silently overwrite another reviewer.
- [x] NFR-7: Empty or unchanged edits are rejected without changing review
  state.

## Acceptance Criteria

1. Given 100 candidate chunks, when inspection completes, then the report says
   100 inspected chunks even when no findings exist.
2. Given an empty chunk, when inspected, then it receives a blocking
   `EMPTY_CHUNK` finding.
3. Given table-like text marked as ordinary text, when inspected, then it
   receives `TABLE_LIKE_TEXT_NOT_MARKED_TABLE`.
4. Given a chunk ending in `Product &` and the next chunk beginning with `Fund
   Manager`, when inspected, then both fragments are surfaced by a blocking
   `CROSS_CHUNK_ROW_CONTINUATION` finding.
5. Given an open blocking finding, when approval is requested, then approval is
   rejected.
6. Given a review-ready document, when its review page is opened, then all open
   findings are visible with page, section, metadata, previous text, and next
   text.
7. Given an approved run, production embedding may proceed; given an unapproved
   run, it may not.
8. Given a flagged boundary, when a reviewer edits either neighboring chunk,
   then the entire document is reinspected and approval counts are refreshed.
9. Given two reviewers loading the same candidate, when the first saves an edit,
   then the second reviewer receives a conflict instead of overwriting it.
10. Given an edited chunk, its original and revised text are both available in
    the audit history.

## Edge Cases

1. An empty document returns a valid report with zero candidates and a
   document-level `NO_CHUNKS` blocking finding.
2. Tables may exceed the ordinary text token limit but not the configured table
   limit.
3. Short chunks with an explicit semantic heading are not automatically
   blocking.
4. Reinspection with a new inspector version creates a new explainable result
   rather than rewriting historical review events.
5. Accepting a false positive resolves only that finding, not other findings on
   the chunk.
6. Editing after approval, rejection, embedding, staging, or publication is
   rejected.
7. Editing one candidate may clear, create, or move a cross-chunk finding on an
   adjacent candidate.

## Out of Scope

- Adding, deleting, splitting, merging, or reordering candidate chunks.
- LLM-based inspection or automatic factual contradiction resolution.
- Multi-reviewer quorum approval.
- General-purpose document annotation.

## Technical Decisions

| Decision | Rationale | Alternative |
| --- | --- | --- |
| Store candidates separately from vector rows | Review must happen before embedding | Nullable embeddings in production chunks |
| Deterministic rules first | Fast, testable, and explainable | LLM-only inspection |
| Unified review model for PDF and HTML | One review UI and workflow | Duplicate review tables |
| Server-rendered Hono UI | Existing API framework and minimal new surface | New SPA framework |
| Findings are versioned; decisions are audit logged | Historical inspection remains explainable | Unversioned mutable findings |
| Text edits create append-only revisions | Reviewers can recover exactly what changed | Store only the latest text |
| Reinspect the whole document after an edit | Boundary rules depend on neighboring chunks | Reinspect only the edited chunk |
