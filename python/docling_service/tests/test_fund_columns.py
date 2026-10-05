"""Side-by-side fund tables (T18k): one key-value part per fund column.

A header cell names a fund when it starts with one of the source's fund-name prefixes and, after
its symbol / former-name / footnote text, ends with a fund-type word. A table splits when its
header row has >= 2 such columns, row labels sit in the first occupied column, and every other
value column header is empty. A header-less table directly below a split table on the same page,
with the same columns at the same x positions, splits with the same fund names.
"""

import pytest
from docling_core.types.doc import BoundingBox, CoordOrigin, DoclingDocument, ProvenanceItem, Size, TableCell, TableData

from docling_service.normalize import tables
from docling_service.normalize.text import repair_document_ordinals
from docling_service.tests.conftest import load_doc

PREFIXES = ("Mirae Asset",)
PAGE_HEIGHT = 800.0
FUNDS = ["Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund", "Mirae Asset Flexi Cap Fund"]


# --- fund_name -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Mirae Asset Large Cap Fund", ("Mirae Asset Large Cap Fund", "")),
        ("MIRAE ASSET LARGE CAP FUND", ("MIRAE ASSET LARGE CAP FUND", "")),
        ("Mirae Asset  Large &\nMidcap Fund", ("Mirae Asset Large & Midcap Fund", "")),
        (
            "Mirae Asset BSE 200 Equal Weight ETF NSE Symbol: EQUAL200 , BSE Scrip Code: 544377",
            ("Mirae Asset BSE 200 Equal Weight ETF", "NSE Symbol: EQUAL200, BSE Scrip Code: 544377"),
        ),
        (
            "Mirae Asset Nifty200 Momentum 30 Plus 8-13yr G-Sec 75:25 Index Fund $",
            ("Mirae Asset Nifty200 Momentum 30 Plus 8-13yr G-Sec 75:25 Index Fund", ""),
        ),
        ("Mirae Asset Nifty 50 ETF (NSE Symbol: NIFTYETF)", ("Mirae Asset Nifty 50 ETF", "(NSE Symbol: NIFTYETF)")),
        ("Mirae Asset Global X Artificial Intelligence & Technology ETF Fund of Fund",
         ("Mirae Asset Global X Artificial Intelligence & Technology ETF Fund of Fund", "")),
        ("Mirae Asset Equity Allocator FoF", ("Mirae Asset Equity Allocator FoF", "")),
        ("Mirae Asset Nifty 1D Rate Liquid ETF - IDCW*", ("Mirae Asset Nifty 1D Rate Liquid ETF", "IDCW*")),
        # active p46: footnote number after the name; a former name after it
        ("Mirae Asset Ultra Short to Short Term Fund 1", ("Mirae Asset Ultra Short to Short Term Fund", "")),
        (
            "Mirae Asset Dynamic Term Fund Erstwhile known as Mirae Asset Dynamic Bond Fund 1",
            ("Mirae Asset Dynamic Term Fund", "Erstwhile known as Mirae Asset Dynamic Bond Fund 1"),
        ),
        # passive p110: ` - ` inside the name
        ("Mirae Asset Crisil IBX Gilt Index - April 2033 Index Fund", ("Mirae Asset Crisil IBX Gilt Index - April 2033 Index Fund", "")),
    ],
)
def test_fund_name_matches_prefix_and_fund_type_ending(text, expected):
    assert tables.fund_name(text, PREFIXES) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Scheme Benchmark*",
        "Mirae Asset Equity Snapshot",
        "Nifty 100 (TRI)",
        "Key Features",
        "Mirae Asset",
        "HDFC Large Cap Fund",
        "The Mirae Asset Large Cap Fund",
    ],
)
def test_fund_name_rejects_non_fund_headers(text):
    assert tables.fund_name(text, PREFIXES) is None


def test_fund_name_without_prefixes_matches_nothing():
    assert tables.fund_name("Mirae Asset Large Cap Fund", ()) is None


# --- synthetic tables ----------------------------------------------------------------------


def _cell(r, c, text, *, top=100.0, col_x=None, end_c=None, header=False):
    end = end_c if end_c is not None else c + 1
    x = col_x or (lambda col: 50.0 + col * 120.0)
    bbox = BoundingBox(l=x(c), t=top + r * 10.0, r=x(end - 1) + 90.0, b=top + r * 10.0 + 8.0, coord_origin=CoordOrigin.TOPLEFT)
    return TableCell(
        bbox=bbox, text=text, start_row_offset_idx=r, end_row_offset_idx=r + 1,
        start_col_offset_idx=c, end_col_offset_idx=end, column_header=header,
    )


def _add_table(doc, grid, *, page=1, top=100.0, col_x=None, header=True, notes=()):
    """grid rows of strings ("" = no cell); row 0 is flagged column_header when header=True; notes are
    full-width rows appended below."""
    cells = [
        _cell(r, c, text, top=top, col_x=col_x, header=header and r == 0)
        for r, row in enumerate(grid)
        for c, text in enumerate(row)
        if text
    ]
    num_cols = max(len(row) for row in grid)
    for i, note in enumerate(notes):
        cells.append(_cell(len(grid) + i, 0, note, top=top, col_x=col_x, end_c=num_cols))
    rows = len(grid) + len(notes)
    prov = ProvenanceItem(
        page_no=page,
        bbox=BoundingBox(l=40.0, t=PAGE_HEIGHT - top + 2, r=560.0, b=PAGE_HEIGHT - (top + rows * 10.0 + 2), coord_origin=CoordOrigin.BOTTOMLEFT),
        charspan=(0, 0),
    )
    return doc.add_table(data=TableData(num_rows=rows, num_cols=num_cols, table_cells=cells), prov=prov)


def _doc(pages=1):
    doc = DoclingDocument(name="synthetic")
    for page in range(1, pages + 1):
        doc.add_page(page_no=page, size=Size(width=600.0, height=PAGE_HEIGHT))
    return doc


FACTS = [
    ["Key Features", *FUNDS],
    ["Type of Scheme", "Large cap scheme", "Mid cap scheme", "Flexi cap scheme"],
    ["Allotment Date", "4th April 2008", "29th July 2019", "24th February 2023"],
    ["Monthly Average AUM (₹ Cr.)", "38,692.946", "17,200.100", "4,474.120"],
]


def _parts(doc, table, prefixes=PREFIXES):
    columns = tables.fund_columns(doc, prefixes)
    return tables.normalize_table(table, columns.get(table.self_ref))


def test_fund_columns_split_into_one_key_value_part_per_fund():
    doc = _doc()
    table = _add_table(doc, FACTS, notes=["*Investors should consult their financial advisers."])
    parts = _parts(doc, table)
    assert [p.title for p in parts] == [*FUNDS, None]
    assert [p.kind for p in parts] == ["key_value"] * 4
    assert parts[0].text.split("\n") == [
        "Type of Scheme: Large cap scheme",
        "Allotment Date: 4th April 2008",
        "Monthly Average AUM (₹ Cr.): 38,692.946",
    ]
    assert parts[2].text.split("\n")[2] == "Monthly Average AUM (₹ Cr.): 4,474.120"
    assert parts[3].text == "*Investors should consult their financial advisers."
    assert all("table_fund_columns_split" in p.flags for p in parts)
    for fund, part in zip(FUNDS, parts):
        others = [f for f in FUNDS if f != fund]
        assert not any(o in part.text for o in others)


def test_fund_part_cells_are_its_own_column_only():
    doc = _doc()
    table = _add_table(doc, FACTS)
    parts = _parts(doc, table)
    for col, part in enumerate(parts[:3], start=1):
        cols = {c.start_col_offset_idx for cells in part.line_cells for c in cells}
        assert cols == {col}
        assert [c.text for c in part.head_cells] == [FUNDS[col - 1]]


def test_symbol_text_in_the_header_becomes_the_first_line():
    doc = _doc()
    grid = [row[:] for row in FACTS]
    grid[0][1] = "Mirae Asset Large Cap Fund NSE Symbol: LARGECAP , BSE Scrip Code: 500001"
    parts = _parts(doc, _add_table(doc, grid))
    assert parts[0].title == "Mirae Asset Large Cap Fund"
    assert parts[0].text.split("\n")[0] == "NSE Symbol: LARGECAP, BSE Scrip Code: 500001"
    assert parts[1].text.split("\n")[0] == "Type of Scheme: Mid cap scheme"


def test_value_spanning_several_fund_columns_goes_to_each():
    doc = _doc()
    table = _add_table(doc, FACTS[:2])
    span = _cell(2, 1, "Regular Plan and Direct Plan", end_c=4)
    label = _cell(2, 0, "Plans Available")
    table.data.table_cells += [label, span]
    table.data.num_rows = 3
    parts = _parts(doc, table)
    assert [p.text.split("\n")[-1] for p in parts] == ["Plans Available: Regular Plan and Direct Plan"] * 3


def test_without_prefixes_the_table_is_unchanged():
    doc = _doc()
    table = _add_table(doc, FACTS)
    assert tables.fund_columns(doc, ()) == {}
    [part] = tables.normalize_table(table)
    assert part.kind == "table"
    assert "Type of Scheme, Mirae Asset Large Cap Fund = Large cap scheme" in part.text


@pytest.mark.parametrize(
    "header",
    [
        ["Period", "Mirae Asset Large Cap Fund", "Scheme Benchmark*", "Additional Benchmark**"],  # p98: one fund
        ["Key Features", "Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund", "Features"],  # p111: stray header
        ["Period", "Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund", "Benchmark"],
        ["Key Features", "Mirae Asset Large Cap Fund", "", ""],
    ],
)
def test_tables_with_fewer_than_two_funds_or_other_value_headers_stay_whole(header):
    doc = _doc()
    table = _add_table(doc, [header, *FACTS[1:]])
    assert tables.fund_columns(doc, PREFIXES) == {}
    assert len(tables.normalize_table(table)) == 1


def test_numeric_row_labels_do_not_split():
    doc = _doc()
    grid = [["Year", *FUNDS], ["2024", "1.0%", "2.0%", "3.0%"], ["2025", "1.5%", "2.5%", "3.5%"]]
    _add_table(doc, grid)
    assert tables.fund_columns(doc, PREFIXES) == {}


def test_values_in_a_column_without_header_do_not_split():
    doc = _doc()
    grid = [[*row, ""] for row in FACTS]
    grid[1][4] = "stray value"
    _add_table(doc, grid)
    assert tables.fund_columns(doc, PREFIXES) == {}


# --- continuation tables (case 3) ----------------------------------------------------------

CONTINUATION = [
    ["Systematic Investment Plan (SIP)", "NA", "NA", "Daily, Monthly"],
    ["Plans Available", "Regular and Direct", "None", "Regular and Direct"],
]


def test_header_less_table_below_a_split_table_inherits_its_fund_columns():
    doc = _doc()
    first = _add_table(doc, FACTS)
    second = _add_table(doc, CONTINUATION, top=200.0, header=False)
    columns = tables.fund_columns(doc, PREFIXES)
    assert set(columns) == {first.self_ref, second.self_ref}
    parts = tables.normalize_table(second, columns[second.self_ref])
    assert [p.title for p in parts] == FUNDS
    assert parts[0].text.split("\n") == ["Systematic Investment Plan (SIP): NA", "Plans Available: Regular and Direct"]
    assert parts[2].text.split("\n")[0] == "Systematic Investment Plan (SIP): Daily, Monthly"
    assert [p.head_cells for p in parts] == [(), (), ()]


def test_symbol_line_is_not_repeated_on_the_continuation():
    doc = _doc()
    grid = [row[:] for row in FACTS]
    grid[0][1] = "Mirae Asset Large Cap Fund NSE Symbol: LARGECAP"
    _add_table(doc, grid)
    second = _add_table(doc, CONTINUATION, top=200.0, header=False)
    parts = tables.normalize_table(second, tables.fund_columns(doc, PREFIXES)[second.self_ref])
    assert parts[0].text.split("\n")[0] == "Systematic Investment Plan (SIP): NA"


def test_continuation_needs_the_same_page_column_count_and_x_positions():
    shifted = _doc()
    _add_table(shifted, FACTS)
    _add_table(shifted, CONTINUATION, top=200.0, header=False, col_x=lambda col: 50.0 + col * 120.0 + 70.0)
    assert len(tables.fund_columns(shifted, PREFIXES)) == 1

    other_page = _doc(pages=2)
    _add_table(other_page, FACTS)
    _add_table(other_page, CONTINUATION, page=2, top=200.0, header=False)
    assert len(tables.fund_columns(other_page, PREFIXES)) == 1

    narrower = _doc()
    _add_table(narrower, FACTS)
    _add_table(narrower, [row[:3] for row in CONTINUATION], top=200.0, header=False)
    assert len(tables.fund_columns(narrower, PREFIXES)) == 1


def test_continuation_whose_first_data_row_docling_flagged_as_header_still_inherits():
    """passive p93: the lower table's `Systematic Investment Plan (SIP) | NA | NA | NA` row is flagged
    column_header; its values are data (NA, numbers, sentences), not column names."""
    doc = _doc()
    _add_table(doc, FACTS)
    second = _add_table(doc, [["Systematic Investment Plan (SIP)", "NA", "NA", "NA"], *CONTINUATION[1:],
                              ["Monthly Average AUM (₹ Cr.)", "32.1059", "77.7479", "301.9487"]], top=200.0, header=True)
    columns = tables.fund_columns(doc, PREFIXES)
    assert second.self_ref in columns
    parts = tables.normalize_table(second, columns[second.self_ref])
    assert parts[0].text.split("\n")[0] == "Systematic Investment Plan (SIP): NA"


def test_a_table_with_its_own_header_is_not_a_continuation():
    doc = _doc()
    _add_table(doc, FACTS)
    second = _add_table(doc, [["Period", "1 Year", "3 Years", "5 Years"], ["Return", "1%", "2%", "3%"]], top=200.0)
    assert second.self_ref not in tables.fund_columns(doc, PREFIXES)


# --- factsheet pages -----------------------------------------------------------------------


def _fixture_parts(stem, ref):
    doc = load_doc(stem)
    repair_document_ordinals(doc)
    table = next(t for t in doc.tables if t.self_ref == ref)
    return tables.normalize_table(table, tables.fund_columns(doc, PREFIXES).get(ref))


def test_active_fund_facts_p14_splits_per_fund_with_shared_note():
    parts = _fixture_parts("mirae-fund-facts-p14", "#/tables/0")
    assert [p.title for p in parts] == [
        "Mirae Asset Large Cap Fund", "Mirae Asset Large & Midcap Fund", "Mirae Asset Great Consumer Fund", None,
    ]
    assert parts[0].text.split("\n")[0].startswith("Type of Scheme: An open-ended equity scheme predominantly investing across large cap stocks")
    assert "Allotment Date: 4th April 2008" in parts[0].text.split("\n")
    assert "Allotment Date: 29th March 2011" in parts[2].text.split("\n")
    assert "Monthly Average AUM (₹ Cr.): 45,665.455" in parts[1].text.split("\n")
    assert parts[3].text.startswith("*Investors should consult their financial advisers")


def test_snapshot_p10_splits_per_fund():
    parts = _fixture_parts("mirae-fund-facts-p10", "#/tables/0")
    assert [p.title for p in parts] == [
        "Mirae Asset Large Cap Fund", "Mirae Asset Large & Midcap Fund", "Mirae Asset Great Consumer Fund",
    ]
    assert "Net AUM ₹ Crores: 4,742.18" in parts[2].text.split("\n")
    assert "Information Ratio: -0.66" in parts[0].text.split("\n")


def test_passive_fund_facts_p92_splits_both_tables_with_the_same_funds():
    funds = ["Mirae Asset BSE 200 Equal Weight ETF", "Mirae Asset BSE Select IPO ETF", "Mirae Asset Nifty50 Equal Weight ETF"]
    top = _fixture_parts("mirae-passive-fund-facts-p92", "#/tables/0")
    bottom = _fixture_parts("mirae-passive-fund-facts-p92", "#/tables/1")
    assert [p.title for p in top] == funds
    assert [p.title for p in bottom] == funds
    assert top[0].text.split("\n")[0] == "NSE Symbol: EQUAL200, BSE Scrip Code: 544377"
    assert bottom[0].text.split("\n")[0] == "Systematic Investment Plan (SIP): NA"


def test_fund_performance_p98_never_splits():
    doc = load_doc("mirae-fund-performance-p98")
    assert tables.fund_columns(doc, PREFIXES) == {}
