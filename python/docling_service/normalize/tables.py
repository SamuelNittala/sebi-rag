"""Table normalization: serialize from unique `table_cells`, never from the span-duplicated grid.

- Title row (row 0 holds the only non-empty cell, no column headers) becomes a heading.
- Key-value panels become one `label: value` line per row, with sub-header rows
  (`NAV: | Direct | Regular`) folded into the following value rows.
- Grids use triplets (`row label, column header = value`), one line per row;
  header-less grids whose first row is all labels get that row promoted to header.
- Tables over TABLE_MAX_TOKENS split by rows; every triplet line carries its column header.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import groupby
from typing import Literal

from docling_core.types.doc import TableCell, TableItem

from docling_service.normalize.text import is_value_only

# Matches the inspector's table budget (packages/core/src/chunk-inspection/index.ts).
TABLE_MAX_TOKENS = 1536

Row = list[TableCell]


@dataclass(frozen=True)
class TablePart:
    kind: Literal["table", "key_value"]
    text: str
    title: str | None
    flags: tuple[str, ...]


def estimate_tokens(text: str) -> float:
    return len(text.split()) * 1.3


def normalize_table(table: TableItem, max_tokens: int = TABLE_MAX_TOKENS) -> list[TablePart]:
    cells = sorted(table.data.table_cells, key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
    rows = [_non_empty(list(group)) for _, group in groupby(cells, key=lambda c: c.start_row_offset_idx)]
    rows = [row for row in rows if row]
    has_column_header = any(c.column_header for c in cells)
    flags: list[str] = []

    title = None
    if not has_column_header and len(rows) > 1 and len(rows[0]) == 1:
        title = rows[0][0].text.strip()
        rows = rows[1:]
        flags.append("heading_from_table_title")

    if not has_column_header and _is_key_value_panel(rows, table.data.num_cols):
        kind: Literal["table", "key_value"] = "key_value"
        lines = _key_value_lines(rows)
        flags.append("kv_panel_detected")
    else:
        kind = "table"
        if has_column_header:
            header_count = next((i for i, row in enumerate(rows) if not any(c.column_header for c in row)), len(rows))
        elif len(rows) > 1 and len(rows[0]) >= 2 and not any(_is_numeric(c.text) for c in rows[0]):
            header_count = 1
            flags.append("table_header_promoted")
        else:
            header_count = 0
        lines = _triplet_lines(rows[:header_count], rows[header_count:], table.data.num_cols)

    if any(_span(c) > 1 for c in cells):
        flags.append("table_span_collapsed")

    groups = _split_lines(lines, max_tokens)
    if len(groups) > 1:
        flags.append("table_rows_split")
    return [TablePart(kind=kind, text="\n".join(group), title=title, flags=tuple(flags)) for group in groups]


def _non_empty(row: Row) -> Row:
    return [c for c in row if c.text.strip()]


def _span(cell: TableCell) -> int:
    return max(
        cell.end_row_offset_idx - cell.start_row_offset_idx,
        cell.end_col_offset_idx - cell.start_col_offset_idx,
    )


def _is_numeric(text: str) -> bool:
    return is_value_only(text) or text.strip() in {"--", "-"}


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


def _triplet_lines(header_rows: list[Row], body_rows: list[Row], num_cols: int) -> list[str]:
    column_names: dict[int, str] = {}
    for col in range(num_cols):
        names: list[str] = []
        for row in header_rows:
            for c in row:
                if c.start_col_offset_idx <= col < c.end_col_offset_idx and c.text.strip() not in names:
                    names.append(c.text.strip())
        column_names[col] = " ".join(names) or str(col)

    lines: list[str] = []
    for row in body_rows:
        label_cell = row[0] if row[0].start_col_offset_idx == 0 else None
        label = label_cell.text.strip() if label_cell else ""
        triplets = [
            f"{label}, {column_names[c.start_col_offset_idx]} = {c.text.strip()}"
            if label
            else f"{column_names[c.start_col_offset_idx]} = {c.text.strip()}"
            for c in row
            if c is not label_cell
        ]
        lines.append(". ".join(triplets) or label)
    return lines


def _split_lines(lines: list[str], max_tokens: int) -> list[list[str]]:
    groups: list[list[str]] = [[]]
    size = 0.0
    for line in lines:
        cost = estimate_tokens(line)
        if groups[-1] and size + cost > max_tokens:
            groups.append([])
            size = 0.0
        groups[-1].append(line)
        size += cost
    return groups
