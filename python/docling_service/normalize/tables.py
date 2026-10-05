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
- Side-by-side fund tables (Snapshot and Fund Facts pages: one column per fund, `fund_columns`) split
  into one key-value part per fund column, when the source passes fund-name prefixes. A header cell
  names a fund when it starts with a prefix and its name part (before a parenthetical, `NSE Symbol`,
  ` - <plan>` or a former name; footnote markers and numbers dropped) ends with Fund/Funds/ETF/FoF/
  Fund of Fund(s). The table splits when its first or second row has >= 2 such cells, every other
  cell of that row covers the label column (any other value header, `Scheme Benchmark*`, `Period`, a
  stray `Features`, keeps it whole), row labels are text and every body value covers a fund column.
  Each part: title = fund name, the header's symbol text as first line, `label: value` per row (a
  value spanning several fund columns goes to each), cells of that column only (its own bbox);
  full-width notes and rows above the header form one shared part. A header-less table directly
  below a split table on the same page (Docling cuts a Fund Facts grid in two) with the same columns
  at the same x positions splits with the same funds; a first data row Docling flags as a header
  (`SIP | NA | NA | NA`) does not stop it. Parts carry `table_fund_columns_split`.
- One line per row, every triplet line carrying its column header, so chunks.py can split a
  long table between rows (budget.py) without losing context.
- Each part keeps the source cells behind every text line (`line_cells`; rows that yield no line,
  such as a repeated column header or a key-value sub-header, go with the next line) and its title
  and column header cells (`head_cells`), so chunks.py can draw one bbox per part and per budget
  piece instead of the whole table's.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from itertools import groupby
from typing import Literal, Sequence

from docling_core.types.doc import BoundingBox, DoclingDocument, TableCell, TableItem

from docling_service.normalize.text import is_value_only

Row = list[TableCell]


@dataclass(frozen=True)
class TablePart:
    kind: Literal["table", "key_value"]
    text: str
    title: str | None
    flags: tuple[str, ...]
    line_cells: tuple[Row, ...] = ()  # source cells of each line of `text`, aligned with text.split("\n")
    head_cells: Row = ()  # title and column header cells


Line = tuple[str, Row]  # a text line and the cells it was built from


def _part(kind, lines: list[Line], title: str | None, flags, head: list[TableCell]) -> TablePart:
    """A part from (line, cells) pairs; a line holding newlines (cell text) keeps its cells on each."""
    split = [(piece, cells) for line, cells in lines for piece in line.split("\n")]
    return TablePart(
        kind=kind,
        text="\n".join(line for line, _ in split),
        title=title,
        flags=tuple(flags),
        line_cells=tuple(tuple(cells) for _, cells in split),
        head_cells=tuple(head),
    )


def _attach_pending(lines: list[Line], pending: list[TableCell]) -> list[Line]:
    """Cells of trailing rows that produced no line go with the last line."""
    if pending and lines:
        line, cells = lines[-1]
        return [*lines[:-1], (line, (*cells, *pending))]
    return lines


def _rows(table: TableItem) -> list[Row]:
    """Non-empty cells grouped by start row, rows in order, empty rows dropped."""
    cells = sorted(table.data.table_cells, key=lambda c: (c.start_row_offset_idx, c.start_col_offset_idx))
    rows = [_non_empty(list(group)) for _, group in groupby(cells, key=lambda c: c.start_row_offset_idx)]
    return [row for row in rows if row]


def normalize_table(table: TableItem, fund_columns: FundColumns | None = None) -> list[TablePart]:
    """One part per table, one per stacked sub-table, or one per fund column when `fund_columns`
    (from `fund_columns`) is given (see module doc)."""
    rows = _rows(table)
    num_cols = table.data.num_cols
    span_flags = ["table_span_collapsed"] if any(_span(c) > 1 for c in table.data.table_cells) else []

    stacked = None if fund_columns else _stacked_sub_tables(rows)
    if fund_columns:
        parts = _fund_parts(rows, fund_columns)
    elif stacked is None:
        parts = [_normalize_rows(rows, num_cols)]
    else:
        base = _base_labels(stacked)
        parts = [
            _normalize_rows(sub.body, num_cols) if sub.header is None else _sub_table_part(sub, num_cols, base)
            for sub in stacked
        ]
    return [
        TablePart(p.kind, p.text, p.title, (*p.flags, *span_flags), p.line_cells, p.head_cells) for p in parts
    ]


def _normalize_rows(rows: list[Row], num_cols: int) -> TablePart:
    flags: list[str] = []
    title = None
    head: list[TableCell] = []
    if len(rows) > 1 and len(rows[0]) == 1 and _is_title_row(rows):
        title = rows[0][0].text.strip()
        head += rows[0]
        rows = rows[1:]
        flags.append("heading_from_table_title")
    # A value-like cell that Docling flags as a column header is a stray value, not a header
    # (p43 `Fund Information`: the `20th July 2023` value cell). Such flags do not count as a real
    # column header, so the key-value panel is not turned into a grid.
    has_column_header = any(
        c.column_header for row in rows for c in row if not (_is_numeric(c.text) or _has_measure(c.text))
    )
    fund = _fund_name(title)

    # Two-column panels are detected as key-value before any header handling, so a spurious
    # `column_header` flag on a value cell cannot turn the panel into a grid. Grids with a real
    # header row (`Period | <fund>`) are not key-value panels (`_is_key_value_panel`) and fall through.
    if _is_key_value_panel(rows, num_cols) and (num_cols == 2 or not has_column_header):
        kind: Literal["table", "key_value"] = "key_value"
        lines = _key_value_lines(_realign_flagged_values(rows))
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
                header_count = next(
                    (i for i, row in enumerate(rows) if _is_label_row(row) or not any(c.column_header for c in row)),
                    len(rows),
                )
            elif (
                len(rows) > 1
                and len(rows[0]) >= 2
                and not _is_label_row(rows[0])
                and not any(_is_numeric(c.text) or _has_measure(c.text) for c in rows[0])
            ):
                header_count = 1
                flags.append("table_header_promoted")
            else:
                header_count = 0
            header_rows, body_rows = rows[:header_count], rows[header_count:]
        label_col = _label_col(body_rows)
        head += [c for row in header_rows for c in row]
        body_rows = [_split_label_value(row, label_col) for row in body_rows]
        header_rows = [_split_fund_header(row, label_col, body_rows, fund) for row in header_rows]
        lines = _triplet_lines(header_rows, body_rows, num_cols, label_col, label_end)

    return _part(kind, lines, title, flags, head)


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
# A date is a value, never header text: `20th July 2023`, `Aug 31, 2026`, `August 2026`, `31/08/2026`.
_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
# Anchored: the whole cell is a date (optionally with a leading footnote marker). A fund name that
# merely contains a month and year (`Mirae Asset Nifty SDL Jun 2027 Index Fund`) is not a date value.
_DATE_VALUE = re.compile(
    rf"^[*^#$@†\s]*(?:"
    rf"\d{{1,2}}\s?(?:st|nd|rd|th)?\s+{_MONTH}\.?,?\s+\d{{4}}"
    rf"|{_MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"
    rf"|{_MONTH}\.?,?\s+\d{{4}}"
    rf"|\d{{1,2}}[/.-]\d{{1,2}}[/.-]\d{{2,4}})\s*$",
    re.IGNORECASE,
)


def _has_measure(text: str) -> bool:
    """A decimal, grouped number or percentage, or a cell whose whole value is a date: data, not
    header text (`FY 23`, `2026`, a fund name holding a month and year are header text; a cell that
    is just `20th July 2023` is a value)."""
    return _MEASURE.search(text) is not None or _DATE_VALUE.match(text.strip()) is not None


def _is_label_cell(cell: TableCell) -> bool:
    """True when the cell text, after whitespace and footnote markers, ends in `:` (`Benchmark:`,
    `Exit Load :`): a key-value label, never a column header."""
    return cell.text.strip().rstrip("*^#$@† ").rstrip().endswith(":")


def _is_label_row(row: Row) -> bool:
    """A row led by a `label:` cell (its first cell by column); such a row is never a header."""
    return bool(row) and _is_label_cell(min(row, key=lambda c: c.start_col_offset_idx))


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


def _normalize_label(text: str) -> str:
    """Collapse whitespace and drop a space before a trailing colon (`Allotment Date :` -> `Allotment Date:`)."""
    label = " ".join(text.split())
    return re.sub(r"\s+:$", ":", label)


def _vertical_overlap(a: BoundingBox, b: BoundingBox) -> float:
    """Height of the vertical overlap of two TOPLEFT bboxes on the same page (0 when disjoint)."""
    at, ab = sorted((a.t, a.b))
    bt, bb = sorted((b.t, b.b))
    return max(0.0, min(ab, bb) - max(at, bt))


def _realign_flagged_values(rows: list[Row]) -> list[Row]:
    """Docling sometimes assigns a key-value panel's value cell to the wrong row and marks it a
    column header (p43: `20th July 2023` lands on the `Fund Managers` row, while `Allotment Date :`
    gets no value). Move a value cell that Docling flagged as a column header to the label-only row
    whose bbox it vertically aligns with, when its own row already carries a value or a label with no
    free slot. Needs cell bboxes; otherwise the rows are returned unchanged."""
    label_col = _label_col(rows)
    strays = [
        (r, c)
        for r, row in enumerate(rows)
        for c in row
        if c.column_header and c.start_col_offset_idx != label_col and c.bbox is not None
    ]
    if not strays:
        return rows
    out = [list(row) for row in rows]
    for r, cell in strays:
        own = [c for c in out[r] if c is not cell and c.start_col_offset_idx == label_col and c.bbox is not None]
        # Only move a stray that does not line up with its own row's label (it was mis-rowed).
        if not own or any(_vertical_overlap(cell.bbox, c.bbox) > 0 for c in own):
            continue
        candidates = [
            (t, c)
            for t, target in enumerate(out)
            if t != r
            for c in target
            if c.start_col_offset_idx == label_col
            and c.bbox is not None
            and not any(v.start_col_offset_idx != label_col for v in target)  # label-only row
            and _vertical_overlap(cell.bbox, c.bbox) > 0
        ]
        if len(candidates) != 1:
            continue
        target_index = candidates[0][0]
        out[r] = [c for c in out[r] if c is not cell]
        out[target_index] = sorted([*out[target_index], cell.model_copy(update={"column_header": False})],
                                   key=lambda c: c.start_col_offset_idx)
    return [row for row in out if row]


def _key_value_lines(rows: list[Row]) -> list[Line]:
    lines: list[Line] = []
    sub_header: tuple[str, list[int], list[str]] | None = None  # (prefix, value columns, labels)
    pending: list[TableCell] = []  # a sub-header row's cells, carried to the first row it labels
    for index, row in enumerate(rows):
        if len(row) == 1:
            sub_header = None
            lines.append((_normalize_label(row[0].text), (*pending, *row)))
            pending = []
            continue
        first, rest = row[0], row[1:]
        columns = [c.start_col_offset_idx for c in rest]
        if sub_header and columns == sub_header[1]:
            prefix, _, labels = sub_header
            values = "; ".join(f"{label} {c.text.strip()}" for label, c in zip(labels, rest))
            lines.append((f"{prefix} {first.text.strip()} {values}", (*pending, *row)))
            pending = []
            continue
        sub_header = None
        following = rows[index + 1] if index + 1 < len(rows) else None
        if (
            len(rest) >= 2
            and first.text.rstrip().endswith(":")
            and not any(_is_numeric(c.text) for c in rest)
            and following is not None
            and [c.start_col_offset_idx for c in following[1:]] == columns
            and all(_is_numeric(c.text) for c in following[1:])
        ):
            sub_header = (first.text.strip().rstrip(":").strip(), columns, [c.text.strip() for c in rest])
            pending += row
            continue
        label = _normalize_label(first.text)
        separator = "" if label.endswith(":") else ":"
        lines.append((f"{label}{separator} " + " ".join(c.text.strip() for c in rest), (*pending, *row)))
        pending = []
    return _attach_pending(lines, pending)


def _triplet_lines(
    header_rows: list[Row], body_rows: list[Row], num_cols: int, label_col: int, label_end: int | None = None
) -> list[Line]:
    column_names = _column_names(header_rows, label_col, num_cols)

    lines: list[Line] = []
    pending: list[TableCell] = []  # a repeated header row's cells, carried to the next line
    for row in body_rows:
        label_cell = row[0] if row[0].start_col_offset_idx == label_col else None
        label = label_cell.text.strip() if label_cell else ""
        if _is_repeated_header(row, label, column_names.get(label_col, "")):
            # A stacked sub-table's own `Period | Since Inception | 5 Years` row: it names
            # the columns for the rows below it.
            column_names = _column_names([row], label_col, num_cols)
            pending += row
            continue
        if label_cell and label_end is not None and label_cell.end_col_offset_idx < label_end:
            # Not part of the merged header's grid (NAV, Allotment Date rows).
            lines.append((_label_value(label, [c.text.strip() for c in row[1:]]), (*pending, *row)))
        else:
            lines.append((_row_triplets(row, label_cell, label, column_names), (*pending, *row)))
        pending = []
    return _attach_pending(lines, pending)


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
    head: tuple[TableCell, ...] = ()  # source cells of the title and header rows


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
        first = starts[n][0]
        head = tuple(c for row in rows[first : header_index + 1] for c in row)
        subs.append(_SubTable(title, _as_header(header), rows[header_index + 1 : end], head))
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
                    above.model_copy(update={"text": f"{above.text.strip()} {c.text.strip()}", "bbox": _enclosing(above, c)})
                    if above
                    else c
                )
            out[-1] = [by_col[col] for col in sorted(by_col)]
        else:
            out.append(row)
    return out


def _enclosing(a: TableCell, b: TableCell) -> BoundingBox | None:
    """The box around both cells (same origin), else whichever has one."""
    if a.bbox and b.bbox and a.bbox.coord_origin == b.bbox.coord_origin:
        return BoundingBox.enclosing_bbox([a.bbox, b.bbox])
    return a.bbox or b.bbox


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
    return _SubTable(top_label, _as_header(header), [data, *rows[2:]], tuple(top))


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

    lines: list[Line] = []
    pending: list[TableCell] = []  # an echoed header row's cells, carried to the next line
    for row in body:
        label = _label_of(row, label_col)
        label_cell = row[0] if label else None
        values = _values(row, label_col)
        if values and all(" ".join(c.text.split()) == column_names.get(c.start_col_offset_idx) for c in values):
            pending += row
            continue  # an inner header row echoing the column names
        if label and values and not _has_numbers(values):
            # Full-width text (benchmark names) that Docling cut into cells: one value.
            text = f"{label}: {' '.join(c.text.strip() for c in values)}"
        else:
            text = _row_triplets(row, label_cell, label.strip(), column_names) if values else row[0].text.strip()
        lines.append((text, (*pending, *row)))
        pending = []
    return _part("table", _attach_pending(lines, pending), sub.title, flags, list(sub.head))


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


# --- Side-by-side fund columns ------------------------------------------------------------


# A fund name ends in a fund-type word (`... Fund`, `... ETF`, `... FoF`, `... Fund of Fund`).
_FUND_TYPE_END = re.compile(r"\b(?:funds?|etf|fof|fund\s+of\s+funds?)$", re.IGNORECASE)
# Where the name ends inside a header cell: a parenthetical, the exchange symbol, a plan suffix
# (` - IDCW*`) or a former name.
_FUND_NAME_END = re.compile(r"\s*\(|\s+(?:NSE|BSE)\s+(?:Symbol|Scrip)\b|\s+-\s+|\s+(?:Formerly|Erstwhile)\b", re.IGNORECASE)
_FOOTNOTE_MARKS = "*^#$@†ε "


def fund_name(text: str, prefixes: Sequence[str]) -> tuple[str, str] | None:
    """(fund name, rest of the header) when `text` starts with one of the source's fund-name
    prefixes and its name part ends with a fund-type word; the rest is the symbol / plan text
    (`NSE Symbol: EQUAL200, BSE Scrip Code: 544377`), footnote markers dropped. None otherwise."""
    flat = " ".join(text.split())
    if not any(flat.lower().startswith(f"{p.strip().lower()} ") for p in prefixes if p.strip()):
        return None
    # The first cut that leaves a fund-type ending wins (` - ` can sit inside a name: `Gilt Index -
    # April 2033 Index Fund`); a trailing footnote number (`... Fund 1`) is not part of the name.
    for cut in [m.start() for m in _FUND_NAME_END.finditer(flat)] + [len(flat)]:
        name = re.sub(r"(?<=\D)\s+\d{1,2}$", "", flat[:cut].rstrip(_FOOTNOTE_MARKS))
        if _FUND_TYPE_END.search(name):
            if cut == len(flat):
                return name, ""  # only footnote markers or a footnote number follow the name
            return name, re.sub(r"\s+,", ",", flat[cut:].lstrip(_FOOTNOTE_MARKS + "-")).strip()
    return None


@dataclass(frozen=True)
class FundColumns:
    """The fund columns of a side-by-side fund table (`fund_columns`)."""

    names: dict[int, str]  # value column -> fund name
    symbols: dict[int, str]  # value column -> header text after the name; empty on a continuation
    label_col: int
    header_row: int | None  # index into `_rows(table)` of the fund header row; None on a continuation
    spans: dict[int, tuple[float, float]]  # column -> (left, right) x extent of its single-column cells


def fund_columns(doc: DoclingDocument, prefixes: Sequence[str]) -> dict[str, FundColumns]:
    """table self_ref -> fund columns, for tables that split into one part per fund column.

    A table splits on its own header when its first or second row has >= 2 single-column fund-name
    cells (`fund_name`), every other cell of that row covers the label column, the body rows carry
    text row labels in the first occupied column, and every body value covers a fund column. A
    table with no fund header splits as a continuation when it directly follows a split table on
    the same page, below it, has no `column_header` cells, the same column count and label column,
    and its fund columns overlap the table above's by >= half the narrower width. No prefixes: {}."""
    if not any(p.strip() for p in prefixes):
        return {}
    out: dict[str, FundColumns] = {}
    above: tuple[TableItem, FundColumns] | None = None
    for table in doc.tables:
        if not table.prov or not table.data.table_cells:
            continue  # empty riskometer grids between tables
        columns = _own_fund_columns(table, prefixes) or (above and _continuation(doc, table, *above))
        if columns:
            out[table.self_ref] = columns
            above = (table, columns)
        else:
            above = None
    return out


def _covers(cell: TableCell, col: int) -> bool:
    return cell.start_col_offset_idx <= col < cell.end_col_offset_idx


def _single_column(cell: TableCell) -> bool:
    return cell.end_col_offset_idx - cell.start_col_offset_idx == 1


def _column_spans(table: TableItem) -> dict[int, tuple[float, float]]:
    spans: dict[int, tuple[float, float]] = {}
    for c in table.data.table_cells:
        if c.bbox is None or not _single_column(c) or not c.text.strip():
            continue
        left, right = sorted((c.bbox.l, c.bbox.r))
        col = c.start_col_offset_idx
        spans[col] = (min(left, spans[col][0]), max(right, spans[col][1])) if col in spans else (left, right)
    return spans


def _fund_body(body: list[Row], label_col: int, funds: set[int]) -> bool:
    """Body rows of a fund table: >= 2 rows with a text row label and a fund value, no numeric row
    label, and every other cell covering a fund column (a single full-width note row is fine)."""
    labelled = 0
    for row in body:
        label = next((c for c in row if c.start_col_offset_idx == label_col and _single_column(c)), None)
        values = [c for c in row if c is not label]
        if label is not None and _is_numeric(label.text):
            return False
        if any(not any(_covers(c, col) for col in funds) for c in values):
            return False
        if any(_covers(c, label_col) for c in values) and len(row) > 1:
            return False  # a label fused with a value (`Last 1 Year 13.13%`): not a fund-facts row
        labelled += label is not None and bool(values)
    return labelled >= 2


def _own_fund_columns(table: TableItem, prefixes: Sequence[str]) -> FundColumns | None:
    rows = _rows(table)
    for index, row in enumerate(rows[:2]):
        names = {c.start_col_offset_idx: fund_name(c.text, prefixes) for c in row if _single_column(c)}
        found = {col: name for col, name in names.items() if name}
        if len(found) >= 2:
            break
    else:
        return None
    body = rows[index + 1:]
    label_col = _label_col(body)
    if min(found) <= label_col:
        return None
    if any(c.start_col_offset_idx not in found and not _covers(c, label_col) for c in rows[index]):
        return None  # another value header (`Scheme Benchmark*`, `Period`, a stray `Features`)
    if not _fund_body(body, label_col, set(found)):
        return None
    return FundColumns(
        names={col: name for col, (name, _) in found.items()},
        symbols={col: rest for col, (_, rest) in found.items()},
        label_col=label_col,
        header_row=index,
        spans=_column_spans(table),
    )


def _top_left(doc: DoclingDocument, item: TableItem) -> BoundingBox:
    prov = item.prov[0]
    return prov.bbox.to_top_left_origin(page_height=doc.pages[prov.page_no].size.height)


def _continuation(doc: DoclingDocument, table: TableItem, above: TableItem, columns: FundColumns) -> FundColumns | None:
    if table.prov[0].page_no != above.prov[0].page_no or table.data.num_cols != above.data.num_cols:
        return None
    if _top_left(doc, table).t < _top_left(doc, above).b - 5.0:
        return None  # not below the table above
    if any(c.column_header and c.start_col_offset_idx != columns.label_col and not _data_like(c.text) for c in table.data.table_cells):
        return None  # a header naming its own columns (`Period | 1 Year | 3 Years`): another table
    rows = _rows(table)
    if _label_col(rows) != columns.label_col or not _fund_body(rows, columns.label_col, set(columns.names)):
        return None
    spans = _column_spans(table)
    for col in columns.names:
        if col not in spans or col not in columns.spans:
            return None
        (a_l, a_r), (b_l, b_r) = spans[col], columns.spans[col]
        if min(a_r, b_r) - max(a_l, b_l) < 0.5 * min(a_r - a_l, b_r - b_l):
            return None
    return FundColumns(names=columns.names, symbols={}, label_col=columns.label_col, header_row=None, spans=spans)


def _data_like(text: str) -> bool:
    """A value, not a column name: a number or measure, `NA`/`Nil`, or a sentence (>= 6 words).
    Docling flags a continuation's first data row (`SIP | NA | NA | NA`) as a column header."""
    flat = " ".join(text.split())
    return _is_numeric(flat) or _has_measure(flat) or flat.upper() in {"NA", "N.A.", "N/A", "NIL"} or len(flat.split()) >= 6


def _fund_parts(rows: list[Row], columns: FundColumns) -> list[TablePart]:
    """One key-value part per fund column (title = fund name, the header's symbol text first, then
    `label: value` per row with a value in that column; a value spanning several fund columns goes
    to each), then one shared part for full-width notes and rows above the header."""
    flags = ["kv_panel_detected", "table_fund_columns_split"]
    header = rows[columns.header_row] if columns.header_row is not None else []
    body = rows[columns.header_row + 1:] if columns.header_row is not None else rows
    shared: list[Line] = [(" ".join(c.text.strip() for c in row), row) for row in rows[: columns.header_row or 0]]
    lines: dict[int, list[Line]] = {col: [] for col in columns.names}
    for col in columns.names:
        if columns.symbols.get(col):
            lines[col].append((columns.symbols[col], [c for c in header if c.start_col_offset_idx == col]))
    for row in body:
        label = next((c for c in row if c.start_col_offset_idx == columns.label_col and _single_column(c)), None)
        values = [c for c in row if c is not label]
        if label is None and len(values) == 1 and sum(_covers(values[0], col) for col in columns.names) >= 2:
            shared.append((values[0].text.strip(), values))
            continue
        text = _normalize_label(label.text) if label else ""
        for col in columns.names:
            mine = [c for c in values if _covers(c, col)]
            if mine:
                lines[col].append((_label_value(text, [c.text.strip() for c in mine]), mine))
            elif text and not values:
                lines[col].append((text, []))  # a label-only row (sub-header) belongs to every fund
    parts = [
        _part("key_value", lines[col], name, flags, [c for c in header if c.start_col_offset_idx == col])
        for col, name in sorted(columns.names.items())
        if lines[col]
    ]
    if shared:
        parts.append(_part("key_value", shared, None, flags, []))
    return parts
