import re

import pytest

from docling_service.normalize import budget
from docling_service.tests.conftest import GOLDEN_STEMS, REPO_ROOT, SIP_PERFORMANCE_STEM, needs_tokenizer


def _ts_number(path: str, key: str) -> int:
    source = (REPO_ROOT / path).read_text(encoding="utf-8")
    return int(re.search(rf"\b{key}: (\d+)", source).group(1))


def test_limits_match_ts_chunk_config_and_inspector():
    assert budget.TEXT_MAX_TOKENS == 512
    assert budget.TABLE_MAX_TOKENS == 1536
    assert _ts_number("packages/types/src/chunk.ts", "maxTokens") == budget.TEXT_MAX_TOKENS
    assert _ts_number("packages/types/src/chunk.ts", "tableMaxTokens") == budget.TABLE_MAX_TOKENS
    assert _ts_number("packages/core/src/chunk-inspection/index.ts", "maxTextTokens") == budget.TEXT_MAX_TOKENS
    assert _ts_number("packages/core/src/chunk-inspection/index.ts", "maxTableTokens") == budget.TABLE_MAX_TOKENS


def test_only_table_chunks_get_the_table_limit():
    assert budget.limit("table") == budget.TABLE_MAX_TOKENS
    for kind in ("text", "key_value", "picture"):
        assert budget.limit(kind) == budget.TEXT_MAX_TOKENS


def test_cost_counts_whitespace_words_like_estimate_token_count():
    assert budget.cost("Since Inception 12,80,000 = 30,33,315.") == pytest.approx(5 * 1.3)
    assert budget.cost(["Heading one", "a\nb  c"]) == pytest.approx(5 * 1.3)


def test_budget_reserves_scheme_prefix_and_headings():
    headings = ["SIP Performance", "Mirae Asset Large Cap Fund"]
    # floor((1536 - 40) / 1.3) = 1150 words, minus 7 heading words.
    assert budget.body_words("table", headings) == 1143
    assert budget.body_words("text", []) == 363
    assert budget.fits("table", headings, " ".join(["x"] * 1143))
    assert not budget.fits("table", headings, " ".join(["x"] * 1144))


def test_rows_split_at_line_boundaries_with_headings_counted():
    headings = ["Title " + "word " * 40]
    rows = [f"Row {i}, Since Inception 12,80,000 = 30,33,315." for i in range(300)]
    pieces = budget.split_body("table", headings, "\n".join(rows), split_long_lines=False)
    assert len(pieces) > 1
    assert [line for piece in pieces for line in piece.split("\n")] == rows
    assert all(budget.fits("table", headings, piece) for piece in pieces)


def test_body_within_budget_is_one_piece():
    assert budget.split_body("text", ["H"], "a b c\nd e", split_long_lines=True) == ["a b c\nd e"]


def test_long_text_line_splits_by_words_but_table_rows_never_split():
    line = " ".join(f"w{i}" for i in range(1000))
    pieces = budget.split_body("text", [], line, split_long_lines=True)
    assert len(pieces) > 1
    assert " ".join(pieces).split() == line.split()
    assert all(budget.fits("text", [], piece) for piece in pieces)
    assert budget.split_body("key_value", [], line, split_long_lines=False) == [line]


@needs_tokenizer
@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_every_golden_chunk_fits_the_ts_measure(wires, stem):
    over = [
        (c["chunkIndex"], c["type"], budget.cost([*c["headings"], c["text"]]))
        for c in wires[stem]["chunks"]
        if not budget.fits(c["type"], c["headings"], c["text"])
    ]
    assert over == []


@needs_tokenizer
def test_sip_rows_split_and_repeat_the_title(wires):
    tables = [c for c in wires[SIP_PERFORMANCE_STEM]["chunks"] if c["type"] == "table"]
    split = [c for c in tables if "table_rows_split" in c["flags"]]
    assert len(split) >= 2
    assert len({tuple(c["headings"]) for c in split}) == 1
    assert all(c["itemRefs"] == split[0]["itemRefs"] for c in split)
