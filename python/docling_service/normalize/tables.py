"""Table normalization: serialize from unique `table_cells`, never from the span-duplicated grid.

- Title row (row 0 holds the only non-empty cell; with column headers, only above a
  header row and not a `label: value` line) becomes a heading.
- Key-value panels become one `label: value` line per row, with sub-header rows
  (`NAV: | Direct | Regular`) folded into the following value rows.
- Grids use triplets (`row label, column header = value`), one line per row;
  header-less grids whose first row is all labels get that row promoted to header
  (a first row holding measures such as `35,005.470` or `5.34%` is data, never a
  header, whether promoted or flagged `column_header` by Docling).
- Row labels sit in the first occupied column of multi-cell rows. A cell whose column has no header
  text serializes as `row label: value` (several in a row join with `; ` in column
  order), never with the column index. A header cell spanning the label column
  names only that column.
- A row label cell spanning several columns and ending in a measure (`Last 1 Year 13.13%`)
  holds the first value column's value: the value moves to the label cell's last column.
  A header cell spanning the label column and value columns whose text ends with the
  fund name of the table title (`Period Mirae Asset Nifty IT ETF`) is split into the
  label header and that fund's column header.
- A header-less first row whose cells hold `header text + measure` (`Scheme Benchmark* 7.56%`)
  is a header row merged with the first data row: it is split into both. The data label
  starts at the next row label's first word (`Period Multicap Last 1 Year`); header
  fragments without a value (`Mirae` | `Asset 7.25%`) join the next column's header, and a
  header that is a word prefix of the title's fund name becomes that name. Rows whose label
  is narrower than the merged label cell (NAV, Allotment Date) stay `label: value`.
- A body row repeating the label column's header (`Period | Since Inception | 5 Years`) is not
  data: it renames the columns for the rows below it.
- Stacked sub-tables (SIP Performance pages: Docling reads a page of per-fund tables as one) are
  split, one part per sub-table with its own title and column header. A table is stacked when
  >= 2 rows share a short label (the key, `Period`) with only text cells and data below. A
  sub-table starts at a key row (its title is the single-cell row above it) or at a row whose
  label ends with the key (`<fund> Period`: the title fused into the header; header cells ending
  in a column name seen in >= 2 header rows give their leading words to the title). A
  label-less text row continues the row above (`Period | Since` + `Inception | 1 Year`). Rows
  above the first key row whose header label holds the fund name and whose next row starts
  with `Period ` (`Period Total Amount Invested | 10 12,00,000 | 7 Years 8,40,000`) are split
  into title, header and data row. Inside a sub-table: rows of text only are `label: text`
  (benchmark names cut into cells); a cell holding two numbers above a row missing exactly
  those columns gives the second number to that row; labels that are not row labels of >= 2
  sub-tables but together spell several (`Scheme Benchmark Additional` + `Benchmark`) are
  re-split, numbers to the numeric label, text to the text label, and two text labels share
  their text (`Scheme Benchmark / Additional Benchmark: ...`); a value in a column without a
  header moves to the one empty neighbouring named column; rows echoing the column names are
  dropped. Repairs that are not safe keep the cells and flag the part `table_cells_fused`.
- One line per row, every triplet line carrying its column header, so chunks.py can split a
  long table between rows (budget.py) without losing context.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from itertools import groupby
from typing import Literal

from docling_core.types.doc import TableCell, TableItem

from docling_service.normalize.text import is_value_only

Row = list[TableCell]


@dataclass(frozen=True)
class TablePart:
    kind: Literal["table", "key_value"]
    text: str
    title: str | None
    flags: tuple[str, ...]


def normalize_table(table: TableItem) -> list[TablePart]:
    """One part per table, or one per stacked sub-table (see module doc)."""
    cells = sorted(table.data.table_cells, key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
    rows = [_non_empty(list(group)) for _, group in groupby(cells, key=lambda c: c.start_row_offset_idx)]
    rows = [row for row in rows if row]
    num_cols = table.data.num_cols
    span_flags = ["table_span_collapsed"] if any(_span(c) > 1 for c in cells) else []

    stacked = _stacked_sub_tables(rows)
    if stacked is None:
        parts = [_normalize_rows(rows, num_cols)]
    else:
        base = _base_labels(stacked)
        parts = [
            _normalize_rows(sub.body, num_cols) if sub.header is None else _sub_table_part(sub, num_cols, base)
            for sub in stacked
        ]
    return [TablePart(p.kind, p.text, p.title, (*p.flags, *span_flags)) for p in parts]


def _normalize_rows(rows: list[Row], num_cols: int) -> TablePart:
    flags: list[str] = []
    title = None
    if len(rows) > 1 and len(rows[0]) == 1 and _is_title_row(rows):
        title = rows[0][0].text.strip()
        rows = rows[1:]
        flags.append("heading_from_table_title")
    has_column_header = any(c.column_header for row in rows for c in row)
    fund = _fund_name(title)

    if not has_column_header and _is_key_value_panel(rows, num_cols):
        kind: Literal["table", "key_value"] = "key_value"
        lines = _key_value_lines(rows)
        flags.append("kv_panel_detected")
    else:
        kind = "table"
        label_end = None
        merged = None if has_column_header else _split_merged_header_row(rows, fund)
        if merged:
            header_rows, body_rows = [merged[0]], [merged[1], *rows[1:]]
            label_end = merged[1][0].end_col_offset_idx
        else:
            if has_column_header and rows and any(_has_measure(c.text) for c in rows[0]):
                header_count = 0  # Docling flagged a data row (`Index Value ... | ... is 22,022.970 ...`)
            elif has_column_header:
                header_count = next((i for i, row in enumerate(rows) if not any(c.column_header for c in row)), len(rows))
            elif len(rows) > 1 and len(rows[0]) >= 2 and not any(_is_numeric(c.text) or _has_measure(c.text) for c in rows[0]):
                header_count = 1
                flags.append("table_header_promoted")
            else:
                header_count = 0
            header_rows, body_rows = rows[:header_count], rows[header_count:]
        label_col = _label_col(body_rows)
        body_rows = [_split_label_value(row, label_col) for row in body_rows]
        header_rows = [_split_fund_header(row, label_col, body_rows, fund) for row in header_rows]
        lines = _triplet_lines(header_rows, body_rows, num_cols, label_col, label_end)

    return TablePart(kind=kind, text="\n".join(lines), title=title, flags=tuple(flags))


def _is_title_row(rows: list[Row]) -> bool:
    """rows[0] holds one cell. Without column headers it is the title; with them it is the
    title only when it is flagged itself or sits above a header row, and when it is not a
    `label: value` line."""
    if not any(c.column_header for row in rows for c in row):
        return True
    unbracketed = re.sub(r"\([^)]*\)", "", rows[0][0].text)  # `(NSE Symbol: BFSI)` is not a label
    return ":" not in unbracketed and (rows[0][0].column_header or any(c.column_header for c in rows[1]))


def _fund_name(title: str | None) -> str | None:
    """`Mirae Asset Nifty IT ETF (NSE Symbol: ...) - Fund Managers - ...` -> `Mirae Asset Nifty IT ETF`."""
    if not title:
        return None
    name = re.split(r"\s+-\s+|\s*\(", title, maxsplit=1)[0].strip()
    return name or None


def _words(text: str) -> list[str]:
    return text.lower().split()


_TRAILING_MEASURE = re.compile(r"^(?P<head>.*?[^\W\d_].*?)\s+(?P<value>[-+]?[₹$]?\s?\d[\d,]*(?:\.\d+)?\s?%?)$")


def _split_trailing_measure(text: str) -> tuple[str, str] | None:
    """`Scheme Benchmark* 7.56%` -> (`Scheme Benchmark*`, `7.56%`); None unless text ends in one measure."""
    match = _TRAILING_MEASURE.match(text.strip())
    if not match or not _has_measure(match["value"]) or _has_measure(match["head"]):
        return None
    return match["head"].strip(), match["value"].strip()


def _label_col(body_rows: list[Row]) -> int:
    # Full-width note rows do not count: in Fund Facts grids column 0 is empty but a
    # trailing note spans it.
    return min(
        (row[0].start_col_offset_idx for row in body_rows if len(row) > 1),
        default=min((row[0].start_col_offset_idx for row in body_rows if row), default=0),
    )


def _split_label_value(row: Row, label_col: int) -> Row:
    """`Last 1 Year 13.13%` spanning the label and fund columns -> label + value in the last column."""
    first = row[0]
    end = first.end_col_offset_idx
    if len(row) < 2 or first.start_col_offset_idx != label_col or end - first.start_col_offset_idx < 2:
        return row
    parts = _split_trailing_measure(first.text)
    if not parts:
        return row
    label = first.model_copy(update={"text": parts[0], "end_col_offset_idx": end - 1})
    value = first.model_copy(
        update={"text": parts[1], "start_col_offset_idx": end - 1, "row_header": False, "column_header": False}
    )
    return [label, value, *row[1:]]


def _split_fund_header(row: Row, label_col: int, body_rows: list[Row], fund: str | None) -> Row:
    """`Period Mirae Asset Nifty IT ETF` spanning the label and fund columns -> `Period` + fund name."""
    if not fund:
        return row
    out: Row = []
    for c in row:
        start, end = c.start_col_offset_idx, c.end_col_offset_idx
        value_cols = sorted(
            v.start_col_offset_idx for body in body_rows for v in body[1:] if start < v.start_col_offset_idx < end
        )
        words, fund_words = c.text.split(), fund.split()
        if (
            start <= label_col < end
            and value_cols
            and len(words) > len(fund_words)
            and _words(" ".join(words[-len(fund_words):])) == _words(fund)
        ):
            split = value_cols[0]
            out.append(c.model_copy(update={"text": " ".join(words[: -len(fund_words)]), "end_col_offset_idx": split}))
            out.append(c.model_copy(update={"text": fund, "start_col_offset_idx": split}))
        else:
            out.append(c)
    return out


def _split_merged_header_row(rows: list[Row], fund: str | None) -> tuple[Row, Row] | None:
    """A first row holding `header text + measure` cells is a header row merged with the first
    data row; returns (header row, data row) or None."""
    if len(rows) < 2 or len(rows[0]) < 3:
        return None
    first, rest = rows[0][0], rows[0][1:]
    splits = [_split_trailing_measure(c.text) for c in rest]
    split_cols = {c.start_col_offset_idx for c, s in zip(rest, splits) if s}
    next_values = {c.start_col_offset_idx for c in rows[1][1:] if _is_numeric(c.text)}
    if len(split_cols) < 2 or not split_cols <= next_values:
        return None

    words, next_words = first.text.split(), rows[1][0].text.split()
    cut = next((i for i in range(len(words) - 1, 0, -1) if next_words and words[i] == next_words[0]), None)
    header: Row = [first.model_copy(update={"text": " ".join(words[:cut])})] if cut else []
    data: Row = [first.model_copy(update={"text": " ".join(words[cut:]) if cut else first.text.strip()})]
    pending: list[str] = []  # header fragments waiting for a column with a value
    for c, parts in zip(rest, splits):
        if parts is None and not (_is_numeric(c.text) or _has_measure(c.text)):
            pending.append(c.text.strip())
            continue
        head, value = parts if parts else ("", c.text.strip())
        name = " ".join([*pending, head]).strip()
        pending = []
        if fund and name and _words(fund)[: len(_words(name))] == _words(name):
            name = fund  # `Mirae Asset` is the start of `Mirae Asset Multicap Fund`
        if name:
            header.append(c.model_copy(update={"text": name, "column_header": True}))
        data.append(c.model_copy(update={"text": value}))
    return header, data


def _non_empty(row: Row) -> Row:
    return [c for c in row if c.text.strip()]


def _span(cell: TableCell) -> int:
    return max(
        cell.end_row_offset_idx - cell.start_row_offset_idx,
        cell.end_col_offset_idx - cell.start_col_offset_idx,
    )


def _is_numeric(text: str) -> bool:
    return is_value_only(text) or text.strip() in {"--", "-"}


_MEASURE = re.compile(r"\d[.,]\d|\d\s?%")


def _has_measure(text: str) -> bool:
    """A decimal, grouped number or percentage: data, not header text (`FY 23`, `2026` are fine)."""
    return _MEASURE.search(text) is not None


def _is_labelled_row(row: Row) -> bool:
    if len(row) == 1:
        return ":" in row[0].text
    return row[0].text.rstrip().endswith(":")


def _is_key_value_panel(rows: list[Row], num_cols: int) -> bool:
    if not rows:
        return False
    if sum(_is_labelled_row(row) for row in rows) * 2 >= len(rows):
        return True
    pairs = [row for row in rows if len(row) == 2]
    return (
        num_cols == 2
        and bool(pairs)
        and all(not _is_numeric(row[0].text) and is_value_only(row[1].text) for row in pairs)
    )


def _key_value_lines(rows: list[Row]) -> list[str]:
    lines: list[str] = []
    sub_header: tuple[str, list[int], list[str]] | None = None  # (prefix, value columns, labels)
    for index, row in enumerate(rows):
        if len(row) == 1:
            sub_header = None
            lines.append(row[0].text.strip())
            continue
        first, rest = row[0], row[1:]
        columns = [c.start_col_offset_idx for c in rest]
        if sub_header and columns == sub_header[1]:
            prefix, _, labels = sub_header
            values = "; ".join(f"{label} {c.text.strip()}" for label, c in zip(labels, rest))
            lines.append(f"{prefix} {first.text.strip()} {values}")
            continue
        sub_header = None
        following = rows[index + 1] if index + 1 < len(rows) else None
        if (
            first.text.rstrip().endswith(":")
            and not any(_is_numeric(c.text) for c in rest)
            and following is not None
            and [c.start_col_offset_idx for c in following[1:]] == columns
            and all(_is_numeric(c.text) for c in following[1:])
        ):
            sub_header = (first.text.strip().rstrip(":").strip(), columns, [c.text.strip() for c in rest])
            continue
        label = first.text.strip()
        separator = " " if label.endswith(":") else ": "
        lines.append(label + separator + " ".join(c.text.strip() for c in rest))
    return lines


def _triplet_lines(
    header_rows: list[Row], body_rows: list[Row], num_cols: int, label_col: int, label_end: int | None = None
) -> list[str]:
    column_names = _column_names(header_rows, label_col, num_cols)

    lines: list[str] = []
    for row in body_rows:
        label_cell = row[0] if row[0].start_col_offset_idx == label_col else None
        label = label_cell.text.strip() if label_cell else ""
        if _is_repeated_header(row, label, column_names.get(label_col, "")):
            # A stacked sub-table's own `Period | Since Inception | 5 Years` row: it names
            # the columns for the rows below it.
            column_names = _column_names([row], label_col, num_cols)
            continue
        if label_cell and label_end is not None and label_cell.end_col_offset_idx < label_end:
            # Not part of the merged header's grid (NAV, Allotment Date rows).
            lines.append(_label_value(label, [c.text.strip() for c in row[1:]]))
            continue
        lines.append(_row_triplets(row, label_cell, label, column_names))
    return lines


def _row_triplets(row: Row, label_cell: TableCell | None, label: str, column_names: dict[int, str]) -> str:
    segments: list[str] = []
    loose: list[str] = []  # consecutive values whose column has no header
    for c in row:
        if c is label_cell:
            continue
        name = column_names.get(c.start_col_offset_idx, "")
        if not name:
            loose.append(c.text.strip())
            continue
        if loose:
            segments.append(_label_value(label, loose))
            loose = []
        segments.append(f"{label}, {name} = {c.text.strip()}" if label else f"{name} = {c.text.strip()}")
    if loose:
        segments.append(_label_value(label, loose))
    return ". ".join(segments) or label


def _column_names(header_rows: list[Row], label_col: int, num_cols: int) -> dict[int, str]:
    column_names: dict[int, str] = {}
    for col in range(num_cols):
        names: list[str] = []
        for row in header_rows:
            for c in row:
                covers = c.start_col_offset_idx <= col < c.end_col_offset_idx
                spans_label = c.start_col_offset_idx <= label_col < c.end_col_offset_idx
                if covers and (col == label_col or not spans_label) and c.text.strip() not in names:
                    names.append(c.text.strip())
        column_names[col] = " ".join(names)
    return column_names


def _is_repeated_header(row: Row, label: str, label_header: str) -> bool:
    """A body row whose label repeats the label column's header (`Period`; also inside a garbled
    `<fund> Period Total Amount Invested` header) and that holds no values."""
    return (
        bool(label)
        and len(row) >= 3
        and f" {' '.join(_words(label))} " in f" {' '.join(_words(label_header))} "
        and not any(_is_numeric(c.text) or _has_measure(c.text) for c in row)
    )


def _label_value(label: str, values: list[str]) -> str:
    joined = "; ".join(values)
    if not label:
        return joined
    return f"{label} {joined}" if label.endswith(":") else f"{label}: {joined}"



# --- Stacked sub-tables -------------------------------------------------------------------


@dataclass(frozen=True)
class _SubTable:
    title: str | None
    header: Row | None  # None: a leading segment normalized like a plain table
    body: list[Row]


def _label_of(row: Row, label_col: int) -> str:
    return " ".join(row[0].text.split()) if row and row[0].start_col_offset_idx == label_col else ""


def _values(row: Row, label_col: int) -> Row:
    return row[1:] if _label_of(row, label_col) else row


def _has_numbers(cells: Row) -> bool:
    return any(_is_numeric(c.text) for c in cells)


def _is_header_like(cells: Row) -> bool:
    return not any(_is_numeric(c.text) or _has_measure(c.text) for c in cells)


def _ends_with_words(text: str, tail: str) -> bool:
    words, tail_words = _words(text), _words(tail)
    return len(words) >= len(tail_words) and words[len(words) - len(tail_words):] == tail_words


def _stacked_sub_tables(rows: list[Row]) -> list[_SubTable] | None:
    """Split a table holding several stacked sub-tables, each `[title row] <key> header row, data
    rows`, where <key> (`Period`) is the label of >= 2 header rows (no numbers, >= 2 value cells,
    data below). None when the table is not stacked."""
    if len(rows) < 4:
        return None
    label_col = _label_col(rows)
    rows = _merge_continuation_rows(rows, label_col)
    candidates = Counter(
        _label_of(row, label_col)
        for i, row in enumerate(rows[:-1])
        if len(row) >= 3 and _label_of(row, label_col) and _is_header_like(row[1:]) and _has_numbers(_values(rows[i + 1], label_col))
    )
    if not candidates:
        return None
    key, count = candidates.most_common(1)[0]
    if count < 2 or len(key.split()) > 3:
        return None

    exact_headers = [row for row in rows if _label_of(row, label_col) == key and _is_header_like(row[1:])]
    names = Counter(" ".join(c.text.split()) for row in exact_headers for c in row[1:])
    vocabulary = {name for name, n in names.items() if n >= 2}  # column names of >= 2 header rows
    starts: list[tuple[int, str | None, Row, int]] = []  # (first row, title, header row, header row index)
    for i, row in enumerate(rows):
        label = _label_of(row, label_col)
        if len(row) < 2 or not _ends_with_words(label, key) or not _is_header_like(row[1:]):
            continue
        if label == key:
            previous = rows[i - 1] if i > 0 else None
            floor = starts[-1][3] + 1 if starts else 0  # not the previous header row itself
            row = _strip_bled_words(row, vocabulary)
            if previous and len(previous) == 1 and i - 1 >= floor and _is_header_like(previous):
                starts.append((i - 1, previous[0].text.strip(), row, i))
            else:
                starts.append((i, None, row, i))
        else:
            starts.append((i, *_split_fused_title(row, key, vocabulary), i))
    if len(starts) < 2:
        return None

    subs: list[_SubTable] = []
    if starts[0][0] > 0:
        subs.append(_leading_sub_table(rows[: starts[0][0]], key, label_col))
    for n, (_, title, header, header_index) in enumerate(starts):
        end = starts[n + 1][0] if n + 1 < len(starts) else len(rows)
        subs.append(_SubTable(title, _as_header(header), rows[header_index + 1 : end]))
    return subs


def _merge_continuation_rows(rows: list[Row], label_col: int) -> list[Row]:
    """A label-less row of text right under a labelled text row continues it (`Period | Since` +
    `Inception | 3 Years | 1 Year`; `Crisil 1 yr` + `T-Bill`)."""
    out: list[Row] = []
    for row in rows:
        previous = out[-1] if out else None
        if (
            previous
            and row[0].start_col_offset_idx > label_col
            and not _has_numbers(row)
            and _label_of(previous, label_col)
            and not _has_numbers(previous[1:])
        ):
            by_col = {c.start_col_offset_idx: c for c in previous}
            for c in row:
                above = by_col.get(c.start_col_offset_idx)
                by_col[c.start_col_offset_idx] = (
                    above.model_copy(update={"text": f"{above.text.strip()} {c.text.strip()}"}) if above else c
                )
            out[-1] = [by_col[col] for col in sorted(by_col)]
        else:
            out.append(row)
    return out


def _vocabulary_name(text: str, vocabulary: set[str]) -> str | None:
    """The longest known column name `text` ends with, when `text` has words before it."""
    name = max((v for v in vocabulary if _ends_with_words(text, v)), key=len, default=None)
    return name if name and len(text) > len(name) else None


def _strip_bled_words(row: Row, vocabulary: set[str]) -> Row:
    """`as Since Inception` (p104: a word of the two-line title above bled into the header cell)
    -> `Since Inception`, when at most 3 words precede a known column name. Where the words
    belong in the title is unknown, so they are dropped."""
    out: Row = [row[0]]
    for c in row[1:]:
        text = " ".join(c.text.split())
        name = _vocabulary_name(text, vocabulary)
        if name and len(text[: len(text) - len(name)].split()) <= 3:
            c = c.model_copy(update={"text": name})
        out.append(c)
    return out


def _split_fused_title(row: Row, key: str, vocabulary: set[str]) -> tuple[str, Row]:
    """`Mirae Asset Aggressive Hybrid Fund Period | Since Inception | ...` -> title + `Period` header.
    A header cell ending in a column name seen in the other header rows gives its leading words to
    the title (`known as Mirae Asset Since Inception`: a two-line title bled into the header)."""
    label = row[0].text.split()
    title_words = label[: len(label) - len(key.split())]
    header = [row[0].model_copy(update={"text": key})]
    for c in row[1:]:
        text = " ".join(c.text.split())
        name = _vocabulary_name(text, vocabulary)
        if name:
            title_words += text[: len(text) - len(name)].split()
            text = name
        header.append(c.model_copy(update={"text": text}))
    return " ".join(title_words), header


_FRAGMENT_VALUE = re.compile(r"^(?P<fragment>.*?)\s*(?P<value>[-+]?\d[\d,]*(?:\.\d+)?%?)$")


def _leading_sub_table(rows: list[Row], key: str, label_col: int) -> _SubTable:
    """Rows above the first `<key>` header. Pages 104-106 open with the fund name in the header row's
    label cell and `Period` plus some column names (`10`, `7 Years`) read into the first data row
    (`Period Total Amount Invested (in Rs.) | 12,80,000 | 10 12,00,000 | 7 Years 8,40,000`): split
    into title, header and data row. Anything else is normalized as a plain table."""
    plain = _SubTable(None, None, rows)
    if len(rows) < 2:
        return plain
    top, merged = rows[0], rows[1]
    top_label, merged_label = _label_of(top, label_col), _label_of(merged, label_col)
    if len(top) < 3 or not top_label or not _is_header_like(top[1:]) or _ends_with_words(top_label, key):
        return plain
    if not merged_label.startswith(f"{key} ") or len(merged) < 2:
        return plain
    matches = [_FRAGMENT_VALUE.match(" ".join(c.text.split())) for c in merged[1:]]
    if not all(m and _is_numeric(m["value"]) and not _has_measure(m["fragment"]) for m in matches):
        return plain
    names = {c.start_col_offset_idx: (c, " ".join(c.text.split())) for c in top[1:]}
    for c, m in zip(merged[1:], matches):
        if m["fragment"]:
            above = names.get(c.start_col_offset_idx)
            names[c.start_col_offset_idx] = (c, " ".join(filter(None, [m["fragment"], above[1] if above else ""])))
    header = [merged[0].model_copy(update={"text": key})] + [
        cell.model_copy(update={"text": text}) for _, (cell, text) in sorted(names.items())
    ]
    data = [merged[0].model_copy(update={"text": merged_label[len(key) + 1:], "column_header": False})] + [
        c.model_copy(update={"text": m["value"], "column_header": False}) for c, m in zip(merged[1:], matches)
    ]
    return _SubTable(top_label, _as_header(header), [data, *rows[2:]])


def _as_header(row: Row) -> Row:
    return [c.model_copy(update={"column_header": True}) for c in row]


def _base_labels(subs: list[_SubTable]) -> dict[str, bool]:
    """Row labels found in >= 2 sub-tables and not themselves two such labels run together, mapped
    to whether their rows hold numbers (`Fund Return & (%)`) or text (`Scheme Benchmark`)."""
    seen: Counter[str] = Counter()
    numeric: set[str] = set()
    for sub in subs:
        if sub.header is None:
            continue
        label_col = sub.header[0].start_col_offset_idx
        labels = set()
        for row in sub.body:
            label = _label_of(row, label_col)
            if label and len(row) > 1:
                labels.add(label)
                if _has_numbers(row[1:]):
                    numeric.add(label)
        seen.update(labels)
    recurring = {label for label, n in seen.items() if n >= 2}
    atomic = {label for label in recurring if len(_segmentations(label, recurring - {label})) == 0}
    return {label: label in numeric for label in atomic}


def _segmentations(text: str, labels: set[str], limit: int = 2) -> list[list[str]]:
    """Ways to write `text` as >= 1 consecutive labels (word boundaries); stops at `limit`."""
    words = text.split()
    by_first: dict[str, list[list[str]]] = {}
    for label in labels:
        by_first.setdefault(label.split()[0], []).append(label.split())
    results: list[list[str]] = []

    def walk(at: int, path: list[str]) -> None:
        if len(results) >= limit:
            return
        if at == len(words):
            if path:
                results.append(path)
            return
        for candidate in by_first.get(words[at], []):
            if words[at : at + len(candidate)] == candidate:
                walk(at + len(candidate), [*path, " ".join(candidate)])

    walk(0, [])
    return results


def _sub_table_part(sub: _SubTable, num_cols: int, base: dict[str, bool]) -> TablePart:
    header = sub.header or []
    label_col = header[0].start_col_offset_idx
    column_names = _column_names([header], label_col, num_cols)
    flags = ["heading_from_table_title"] if sub.title else []
    body, labels_fused = _split_fused_labels(sub.body, label_col, base)
    body, numbers_fused = _move_fused_numbers(body, label_col)
    body = [_shift_to_named_column(row, label_col, column_names) for row in body]
    if labels_fused or numbers_fused:
        flags.append("table_cells_fused")

    lines: list[str] = []
    for row in body:
        label = _label_of(row, label_col)
        label_cell = row[0] if label else None
        values = _values(row, label_col)
        if values and all(" ".join(c.text.split()) == column_names.get(c.start_col_offset_idx) for c in values):
            continue  # an inner header row echoing the column names
        if label and values and not _has_numbers(values):
            # Full-width text (benchmark names) that Docling cut into cells: one value.
            lines.append(f"{label}: {' '.join(c.text.strip() for c in values)}")
        else:
            lines.append(_row_triplets(row, label_cell, label.strip(), column_names) if values else row[0].text.strip())
    return TablePart(kind="table", text="\n".join(lines), title=sub.title, flags=tuple(flags))


_NUMBER_THEN_TEXT = re.compile(r"^(?P<value>[-+]?\d[\d,]*(?:\.\d+)?%?)\s+(?P<text>\S.*)$")


def _split_fused_labels(body: list[Row], label_col: int, base: dict[str, bool]) -> tuple[list[Row], bool]:
    """Rows whose labels are not base labels but together spell >= 2 of them
    (`Scheme Benchmark Additional` + `Benchmark`; `Add. Benchmark Return & (%) Scheme Benchmark`).
    The numeric label gets the numbers in their columns, a single text label the text; two or more
    text labels share the text (`Scheme Benchmark / Additional Benchmark: ...`, flagged: where one
    name ends is unknown). Returns (rows, whether anything stays fused)."""
    out: list[Row] = []
    fused = False
    i = 0
    while i < len(body):
        if not _label_of(body[i], label_col) or _label_of(body[i], label_col) in base:
            out.append(body[i])
            i += 1
            continue
        j = i
        while j < len(body) and _label_of(body[j], label_col) and _label_of(body[j], label_col) not in base:
            j += 1
        run = body[i:j]
        found = _segmentations(" ".join(_label_of(r, label_col) for r in run), set(base))
        if len(found) == 1 and len(found[0]) >= 2:
            repaired = _relabel(run, found[0], label_col, base)
            if repaired is None:
                out.extend(run)
                fused = True
            else:
                rows, still_fused = repaired
                out.extend(rows)
                fused = fused or still_fused
        else:
            out.extend(run)
        i = j
    return out, fused


def _relabel(run: list[Row], labels: list[str], label_col: int, base: dict[str, bool]) -> tuple[list[Row], bool] | None:
    numeric = [label for label in labels if base[label]]
    text = [label for label in labels if not base[label]]
    if labels != numeric + text or len(numeric) > 1:
        return None
    numbers: Row = []
    texts: Row = []
    for row in run:
        for c in _values(row, label_col):
            value = " ".join(c.text.split())
            split = _NUMBER_THEN_TEXT.match(value)
            if _is_numeric(value):
                numbers.append(c)
            elif split and _is_numeric(split["value"]) and not _is_numeric(split["text"]):
                numbers.append(c.model_copy(update={"text": split["value"]}))
                texts.append(c.model_copy(update={"text": split["text"]}))
            else:
                texts.append(c)
    if bool(numbers) != bool(numeric) or bool(texts) != bool(text):
        return None
    if len({c.start_col_offset_idx for c in numbers}) != len(numbers):
        return None
    template = run[0][0]
    rows: list[Row] = []
    if numeric:
        rows.append([template.model_copy(update={"text": numeric[0]}), *numbers])
    if text:
        joined = texts[0].model_copy(update={"text": " ".join(c.text.strip() for c in texts)})
        rows.append([template.model_copy(update={"text": " / ".join(text)}), joined])
    return rows, len(text) > 1


def _move_fused_numbers(body: list[Row], label_col: int) -> tuple[list[Row], bool]:
    """`8,40,000 12,33,168`: a cell holding two numbers above a row missing exactly those columns
    holds the lower row's value too (p103 Large Cap). The second number moves down; when the
    columns do not line up the cells stay as they are and the part is flagged."""
    out = [list(row) for row in body]
    fused = False
    for i, row in enumerate(out):
        pairs = {
            c.start_col_offset_idx: parts
            for c in _values(row, label_col)
            if len(parts := c.text.split()) == 2 and all(_is_numeric(p) for p in parts)
        }
        if not pairs:
            continue
        below = out[i + 1] if i + 1 < len(out) else None
        if below is None or not _label_of(below, label_col) or not _has_numbers(below[1:]):
            fused = True
            continue
        missing = {c.start_col_offset_idx for c in _values(row, label_col)} - {c.start_col_offset_idx for c in below[1:]}
        if set(pairs) != missing:
            fused = True
            continue
        moved = [c.model_copy(update={"text": pairs[c.start_col_offset_idx][1]}) for c in row[1:] if c.start_col_offset_idx in pairs]
        out[i] = [c.model_copy(update={"text": pairs[c.start_col_offset_idx][0]}) if c.start_col_offset_idx in pairs else c for c in row]
        out[i + 1] = sorted([*below, *moved], key=lambda c: c.start_col_offset_idx)
    return out, fused


def _shift_to_named_column(row: Row, label_col: int, column_names: dict[int, str]) -> Row:
    """A value in a column without a header name moves to the one neighbouring named column that
    is empty in this row (p104: `5.95` one column right of `5 Years`)."""
    values = _values(row, label_col)
    if not _has_numbers(values):
        return row
    taken = {c.start_col_offset_idx for c in row}
    out: Row = []
    for c in row:
        col = c.start_col_offset_idx
        if any(c is v for v in values) and not column_names.get(col):
            targets = [n for n in (col - 1, col + 1) if column_names.get(n) and n not in taken and n != label_col]
            if len(targets) == 1:
                taken.add(targets[0])
                c = c.model_copy(update={"start_col_offset_idx": targets[0], "end_col_offset_idx": targets[0] + 1})
        out.append(c)
    return sorted(out, key=lambda c: c.start_col_offset_idx)
