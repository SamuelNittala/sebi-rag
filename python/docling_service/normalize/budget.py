"""Chunk size budget, measured the way the TypeScript side measures a chunk.

Ingestion maps each wire chunk to candidate text `<scheme name>\\n<headings...>\\n<body>`
(apps/ingestion/src/chunkers/docling-chunk-mapper.ts; the scheme line only when the body
lacks it) and the chunk inspector (packages/core/src/chunk-inspection/index.ts) blocks a
candidate whose `estimateTokenCount` (round(whitespace words * 1.3),
apps/ingestion/src/chunkers/semantic-chunker.ts) exceeds `maxTableTokens` for wire type
`table`, else `maxTextTokens` (text, key_value, picture). The limits below are those
values and DEFAULT_CHUNK_CONFIG's `tableMaxTokens`/`maxTokens` (packages/types/src/chunk.ts);
test_budget.py and apps/ingestion/src/chunkers/docling-golden-token-limits.test.ts pin them.

HybridChunker's HuggingFace token limit (converter.CHUNK_MAX_TOKENS) is a different measure
and excludes headings, so every emitted chunk is also held to this one.

The scheme name comes from page text the mapper reads (`extractSchemeTitleLine`, at most
160 characters), so bodies reserve SCHEME_PREFIX_RESERVE_TOKENS for it: the longest seen
in the Sep 2026 active and Aug 2026 passive Mirae factsheets is 25 words (33 tokens).
A chunk satisfies 1.3 * (heading words + body words) + reserve <= limit, so the rounded
TS count stays within the limit whenever the scheme line costs at most the reserve.
"""

from __future__ import annotations

import math

TEXT_MAX_TOKENS = 512  # DEFAULT_CHUNK_CONFIG.maxTokens / inspector maxTextTokens
TABLE_MAX_TOKENS = 1536  # DEFAULT_CHUNK_CONFIG.tableMaxTokens / inspector maxTableTokens
SCHEME_PREFIX_RESERVE_TOKENS = 40
WORD_TOKENS = 1.3


def limit(kind: str) -> int:
    return TABLE_MAX_TOKENS if kind == "table" else TEXT_MAX_TOKENS


def words(text: str | list[str]) -> int:
    texts = [text] if isinstance(text, str) else text
    return sum(len(t.split()) for t in texts)


def cost(text: str | list[str]) -> float:
    """The unrounded TS estimate (words * 1.3)."""
    return words(text) * WORD_TOKENS


def body_words(kind: str, headings: list[str]) -> int:
    """Whitespace words left for the body: (limit - reserve) / 1.3 minus the heading words.
    Counting whole words keeps the check exact (no float drift at the boundary)."""
    return math.floor((limit(kind) - SCHEME_PREFIX_RESERVE_TOKENS) / WORD_TOKENS) - words(headings)


def fits(kind: str, headings: list[str], body: str) -> bool:
    return words(body) <= body_words(kind, headings)


def split_body(kind: str, headings: list[str], body: str, *, split_long_lines: bool) -> list[str]:
    """Greedy line groups that each fit; a line is never split unless `split_long_lines`
    (text), which cuts an over-budget line into word runs. A single over-budget table row
    stays whole."""
    budget = body_words(kind, headings)
    if words(body) <= budget:
        return [body]
    lines = body.split("\n")
    if split_long_lines:
        lines = [piece for line in lines for piece in _split_line(line, budget)]
    groups: list[list[str]] = [[]]
    size = 0
    for line in lines:
        line_words = words(line)
        if groups[-1] and size + line_words > budget:
            groups.append([])
            size = 0
        groups[-1].append(line)
        size += line_words
    return ["\n".join(group) for group in groups]


def _split_line(line: str, budget: int) -> list[str]:
    parts = line.split()
    if len(parts) <= budget:
        return [line]
    step = max(1, budget)
    return [" ".join(parts[i : i + step]) for i in range(0, len(parts), step)]
