from docling_core.types.doc import DoclingDocument, TableCell, TableData

from docling_service.normalize import tables
from docling_service.normalize.text import repair_document_ordinals
from docling_service.tests.conftest import item


def normalized(doc, ref):
    repair_document_ordinals(doc)
    parts = tables.normalize_table(item(doc, ref))
    assert len(parts) == 1
    return parts[0]


def test_fund_details_panel(fixture_doc):
    part = normalized(fixture_doc, "#/tables/0")
    assert part.kind == "key_value"
    assert part.title == "Fund Details"
    assert part.text.split("\n") == [
        "Date of Inception/ Allotment: 24th February 2023",
        "Benchmark Name ^ : Nifty 500 (TRI)",
        "NAV Growth: Direct ₹17.243; Regular ₹16.373",
        "NAV IDCW: Direct ₹17.192; Regular ₹16.379",
        "Net AUM: ₹4,506.259 Cr.",
        "AAUM: ₹4,474.120 Cr.",
    ]
    assert part.text.count("Net AUM:") == 1
    assert part.text.count("24th February 2023") == 1
    assert "Fund Details" not in part.text
    assert set(part.flags) == {"kv_panel_detected", "table_span_collapsed", "heading_from_table_title"}


def test_two_column_label_value_table(fixture_doc):
    part = normalized(fixture_doc, "#/tables/1")
    assert part.kind == "key_value"
    assert part.title == "Base Expense Ratio^^"
    assert part.text == "Regular Plan: 1.62%\nDirect Plan: 0.43%"
    assert set(part.flags) == {"kv_panel_detected", "heading_from_table_title"}


def test_numbered_measures_with_trailing_note(fixture_doc):
    part = normalized(fixture_doc, "#/tables/2")
    assert part.kind == "key_value"
    assert part.title is None
    assert part.text.split("\n") == [
        "1. Standard Deviation: 14.25%",
        "2. Beta: 0.90",
        "3. Sharpe Ratio: 0.50",
        "4. Information Ratio: -0.14",
        "*One liner/brief inference provided in the table on Page No. 117",
    ]
    assert set(part.flags) == {"kv_panel_detected", "table_span_collapsed"}


def test_fund_performance_triplets_bind_columns(fixture_doc):
    part = normalized(fixture_doc, "#/tables/3")
    assert part.kind == "table"
    lines = part.text.split("\n")
    assert len(lines) == 4
    assert lines[0] == (
        "Returns for last 1 year, Scheme Returns Regular (%) = 6.62%. "
        "Returns for last 1 year, Scheme Returns Direct (%) = 8.15%. "
        "Returns for last 1 year, Benchmark Returns ^ (%) = 5.34%"
    )
    assert "Returns since inception, Benchmark Returns ^ (%) = 15.49%" in lines[3]
    assert part.flags == ()


def test_top_holdings_triplets(fixture_doc):
    part = normalized(fixture_doc, "#/tables/4")
    assert part.kind == "table"
    lines = part.text.split("\n")
    assert len(lines) == 12
    assert lines[0] == "1. ICICI Bank Ltd., %age of net assets = 5.74%"
    assert lines[-1] == "Total, %age of net assets = 100.00%"
    assert part.flags == ()


def test_portfolio_changes_three_columns(fixture_doc):
    part = normalized(fixture_doc, "#/tables/5")
    assert part.kind == "table"
    lines = part.text.split("\n")
    assert len(lines) == 10
    assert lines[0] == (
        "Tenneco Clean Air India Ltd., Name of securities reduced = --. "
        "Tenneco Clean Air India Ltd., Total Weightage (%) = 1.32%"
    )
    assert lines[2] == "--, Name of securities reduced = Divi's Laboratories Ltd.. --, Total Weightage (%) = 1.24%"


def test_header_promotion(fixture_doc):
    part = normalized(fixture_doc, "#/tables/6")
    assert part.kind == "table"
    assert part.text.split("\n") == [
        "Scheme, Previous Month = Very High. Scheme, Current Month = Very High",
        "Benchmark, Previous Month = Very High. Benchmark, Current Month = Very High",
    ]
    assert part.flags == ("table_header_promoted",)


def test_partially_flagged_header_is_a_grid(fixture_doc):
    # tables/7 has column_header on its value columns only: a header row, no promotion.
    part = normalized(fixture_doc, "#/tables/7")
    assert part.text.split("\n") == [
        "Direct, Previous Month = 0.43%. Direct, Current Month = 0.43%",
        "Regular, Previous Month = 1.62%. Regular, Current Month = 1.62%",
    ]
    assert part.flags == ()


def test_placeholder_values_table(fixture_doc):
    part = normalized(fixture_doc, "#/tables/8")
    assert part.kind == "table"
    assert part.text.split("\n") == ["--, Previous Month Rating = --. --, Current Month Rating = --"] * 2


def _synthetic_table(rows: int) -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    cells = [
        TableCell(text="Security name", start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=0, end_col_offset_idx=1, column_header=True),
        TableCell(text="Weight", start_row_offset_idx=0, end_row_offset_idx=1, start_col_offset_idx=1, end_col_offset_idx=2, column_header=True),
    ]
    for r in range(1, rows + 1):
        cells.append(TableCell(text=f"Company number {r} Limited ordinary shares", start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=0, end_col_offset_idx=1))
        cells.append(TableCell(text=f"{r / 10:.2f}%", start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=1, end_col_offset_idx=2))
    doc.add_table(data=TableData(num_rows=rows + 1, num_cols=2, table_cells=cells))
    return doc


def test_large_table_splits_by_rows_with_header_repeated():
    doc = _synthetic_table(300)
    parts = tables.normalize_table(doc.tables[0])
    assert len(parts) > 1
    lines = [line for part in parts for line in part.text.split("\n")]
    assert len(lines) == 300
    assert lines[0] == "Company number 1 Limited ordinary shares, Weight = 0.10%"
    for part in parts:
        assert "table_rows_split" in part.flags
        assert tables.estimate_tokens(part.text) <= tables.TABLE_MAX_TOKENS
        assert all(", Weight = " in line for line in part.text.split("\n"))


def test_small_table_is_not_split():
    parts = tables.normalize_table(_synthetic_table(5).tables[0])
    assert len(parts) == 1
    assert "table_rows_split" not in parts[0].flags
