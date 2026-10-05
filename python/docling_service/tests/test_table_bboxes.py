"""Per-part table bboxes: a table split into several chunks (stacked sub-tables, budget row splits)
gives each chunk the union of its own rows' cell bboxes, in bottom-left-origin PDF points."""

from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, Size, TableCell, TableData

from docling_service.normalize import budget, chunks, tables

PAGE_HEIGHT = 800.0
TABLE_BOX = {"l": 40.0, "t": 710.0, "r": 560.0}  # bottom-left origin; b depends on the row count


def _row_top(r: int) -> float:
    """Top-left-origin top of row r."""
    return 100.0 + r * 10.0


def _cell(r: int, c: int, text: str, with_bbox: bool) -> TableCell:
    bbox = (
        BoundingBox(l=50.0 + c * 120.0, t=_row_top(r), r=140.0 + c * 120.0, b=_row_top(r) + 8.0, coord_origin=CoordOrigin.TOPLEFT)
        if with_bbox
        else None
    )
    return TableCell(
        bbox=bbox, text=text, start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=c, end_col_offset_idx=c + 1
    )


def _doc(grid: list[list[str]], *, with_bbox: bool = True) -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    doc.add_page(page_no=1, size=Size(width=600.0, height=PAGE_HEIGHT))
    cells = [_cell(r, c, text, with_bbox) for r, row in enumerate(grid) for c, text in enumerate(row)]
    num_cols = max(len(row) for row in grid)
    bottom = PAGE_HEIGHT - (_row_top(len(grid)) + 2.0)
    prov = ProvenanceItem(page_no=1, bbox=BoundingBox(**TABLE_BOX, b=bottom, coord_origin=CoordOrigin.BOTTOMLEFT), charspan=(0, 0))
    doc.add_table(data=TableData(num_rows=len(grid), num_cols=num_cols, table_cells=cells), prov=prov)
    return doc


def _wire(doc: DoclingDocument) -> list[dict]:
    table = doc.tables[0]
    unit = chunks._Unit("table", [table], ["SIP PERFORMANCE"], 0)
    return chunks._wire_chunks(unit, doc, set(), {table.self_ref: tables.normalize_table(table)}, {})


def _expected(first_row: int, last_row: int, last_col: int) -> dict:
    """The bottom-left box of rows first_row..last_row, columns 0..last_col."""
    return {
        "page": 1,
        "l": 50.0,
        "t": round(PAGE_HEIGHT - _row_top(first_row), 2),
        "r": round(140.0 + last_col * 120.0, 2),
        "b": round(PAGE_HEIGHT - (_row_top(last_row) + 8.0), 2),
    }


def _table_box(doc: DoclingDocument) -> dict:
    box = doc.tables[0].prov[0].bbox
    return {"page": 1, "l": round(box.l, 2), "t": round(box.t, 2), "r": round(box.r, 2), "b": round(box.b, 2)}


PERIODS = ["Period", "Since Inception", "5 Years", "3 Years"]


def _stacked_grid(second_rows: int) -> list[list[str]]:
    grid = [["Mirae Asset Large Cap Fund"], PERIODS, ["Fund Return & (%)", "14.06", "7.89", "4.88"]]
    grid += [["Mirae Asset Midcap Fund"], PERIODS]
    grid += [[f"Return row number {r} (%)", f"{r}.01", f"{r}.02", f"{r}.03"] for r in range(second_rows)]
    return grid


def test_stacked_sub_tables_get_one_box_each_covering_title_header_and_rows():
    doc = _doc(_stacked_grid(2))
    out = _wire(doc)
    assert [c["headings"][-1] for c in out] == ["Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund"]
    assert out[0]["bboxes"] == [_expected(0, 2, 3)]
    assert out[1]["bboxes"] == [_expected(3, 6, 3)]


def test_budget_split_continuations_cover_only_their_rows():
    doc = _doc(_stacked_grid(200))
    out = _wire(doc)
    midcap = [c for c in out if c["headings"][-1] == "Mirae Asset Midcap Fund"]
    assert len(midcap) >= 2 and all("table_rows_split" in c["flags"] for c in midcap)
    rows = [len(c["text"].split("\n")) for c in midcap]
    first_data_row = 5  # rows 3 (title) and 4 (Period header) belong to the first piece
    starts = [first_data_row + sum(rows[:i]) for i in range(len(rows))]
    assert midcap[0]["bboxes"] == [_expected(3, starts[0] + rows[0] - 1, 3)]
    for piece, start, count in list(zip(midcap, starts, rows))[1:]:
        assert piece["bboxes"] == [_expected(start, start + count - 1, 3)]


def test_key_value_panel_split_by_budget_gets_a_box_per_piece():
    grid = [[f"Label number {r}:", f"value text number {r} with a few more words"] for r in range(60)]
    doc = _doc(grid)
    out = _wire(doc)
    assert len(out) >= 2 and all(c["type"] == "key_value" and "table_rows_split" in c["flags"] for c in out)
    assert all(budget.fits(c["type"], c["headings"], c["text"]) for c in out)
    start = 0
    for piece in out:
        count = len(piece["text"].split("\n"))
        assert piece["bboxes"] == [_expected(start, start + count - 1, 1)]
        start += count
    assert start == 60


def test_parts_without_cell_bboxes_fall_back_to_the_table_bbox():
    doc = _doc(_stacked_grid(2), with_bbox=False)
    out = _wire(doc)
    assert len(out) == 2
    assert all(c["bboxes"] == [_table_box(doc)] for c in out)


def test_a_table_in_one_chunk_keeps_the_table_bbox():
    doc = _doc([PERIODS, ["Fund Return & (%)", "14.06", "7.89", "4.88"], ["Benchmark Return (%)", "13.01", "7.02", "4.10"]])
    [chunk] = _wire(doc)
    assert chunk["bboxes"] == [_table_box(doc)]


def test_part_boxes_stay_inside_the_table_bbox():
    grid = _stacked_grid(2)
    doc = _doc(grid)
    # A cell reaching past the table's right edge (Docling cell boxes can overhang by a point).
    doc.tables[0].data.table_cells[0].bbox = BoundingBox(l=50.0, t=_row_top(0), r=590.0, b=_row_top(0) + 8.0, coord_origin=CoordOrigin.TOPLEFT)
    out = _wire(doc)
    assert out[0]["bboxes"][0]["r"] == TABLE_BOX["r"]


def test_overlapping_neighbour_parts_meet_halfway():
    doc = _doc(_stacked_grid(2))
    # The Large Cap rows' last cell reaches 3 pt into the Midcap title row (a tall two-line cell).
    last = next(c for c in doc.tables[0].data.table_cells if c.start_row_offset_idx == 2 and c.start_col_offset_idx == 3)
    last.bbox = BoundingBox(l=last.bbox.l, t=last.bbox.t, r=last.bbox.r, b=_row_top(3) + 3.0, coord_origin=CoordOrigin.TOPLEFT)
    upper, lower = (c["bboxes"][0] for c in _wire(doc))
    title_top = PAGE_HEIGHT - _row_top(3)
    middle = round((title_top + title_top - 3.0) / 2, 2)
    assert upper["b"] == lower["t"] == middle
    assert upper["t"] == _expected(0, 2, 3)["t"] and lower["b"] == _expected(3, 6, 3)["b"]


def test_side_by_side_parts_never_meet_halfway():
    """Fund-column parts sit next to each other; only vertically stacked pieces that overlap
    horizontally move their edges."""
    left = {1: [50.0, 700.0, 160.0, 600.0]}
    right = {1: [170.0, 690.0, 280.0, 590.0]}  # lower top and bottom, but beside the left box
    assert chunks._meet_halfway([left, right]) == [left, right]
