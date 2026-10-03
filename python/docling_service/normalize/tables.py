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
- A body row repeating the label column's header (`Period | Since Inception | 5 Years` in
  stacked SIP sub-tables) is not data: it renames the columns for the rows below it.
- One line per row, every triplet line carrying its column header, so chunks.py can split a
  long table between rows (budget.py) without losing context.
"""

from __future__ import annotations

import re
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


def normalize_table(table: TableItem) -> TablePart:
    cells = sorted(table.data.table_cells, key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
    rows = [_non_empty(list(group)) for _, group in groupby(cells, key=lambda c: c.start_row_offset_idx)]
    rows = [row for row in rows if row]
    flags: list[str] = []

    title = None
    if len(rows) > 1 and len(rows[0]) == 1 and _is_title_row(rows):
        title = rows[0][0].text.strip()
        rows = rows[1:]
        flags.append("heading_from_table_title")
    has_column_header = any(c.column_header for row in rows for c in row)
    fund = _fund_name(title)

    if not has_column_header and _is_key_value_panel(rows, table.data.num_cols):
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
        lines = _triplet_lines(header_rows, body_rows, table.data.num_cols, label_col, label_end)

    if any(_span(c) > 1 for c in cells):
        flags.append("table_span_collapsed")

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
        lines.append(". ".join(segments) or label)
    return lines


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

