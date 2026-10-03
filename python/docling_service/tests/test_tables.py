from docling_core.types.doc import DoclingDocument, TableCell, TableData, TableItem

from docling_service.normalize import tables
from docling_service.normalize.text import repair_document_ordinals
from docling_service.tests.conftest import item


def normalized(doc, ref):
    repair_document_ordinals(doc)
    return tables.normalize_table(item(doc, ref))


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


def test_large_table_is_one_line_per_row_with_header_repeated():
    # Splitting to the chunk budget happens in chunks.py (budget.split_body), between rows.
    part = tables.normalize_table(_synthetic_table(300).tables[0])
    lines = part.text.split("\n")
    assert len(lines) == 300
    assert lines[0] == "Company number 1 Limited ordinary shares, Weight = 0.10%"
    assert all(", Weight = " in line for line in lines)
    assert "table_rows_split" not in part.flags


def _grid(rows: list[list[tuple[int, int, str, bool]]], num_cols: int) -> TableItem:
    """rows of (start_col, end_col, text, column_header) cells; one table row per entry."""
    doc = DoclingDocument(name="synthetic")
    cells = [
        TableCell(
            text=text,
            start_row_offset_idx=r,
            end_row_offset_idx=r + 1,
            start_col_offset_idx=start,
            end_col_offset_idx=end,
            column_header=header,
        )
        for r, row in enumerate(rows)
        for start, end, text, header in row
    ]
    doc.add_table(data=TableData(num_rows=len(rows), num_cols=num_cols, table_cells=cells))
    return doc.tables[0]


def _lines(table: TableItem) -> list[str]:
    part = tables.normalize_table(table)
    return part.text.split("\n")


def test_header_less_two_column_rows_are_label_value(fund_performance_doc):
    # p88 #/tables/3: NAV/Index/Allotment rows with no column header at all.
    part = normalized(fund_performance_doc, "#/tables/3")
    assert part.kind == "table"
    assert part.text.split("\n") == [
        "NAV as on 31 Aug 2026: ₹2,938.2491",
        "Index Value 31st Aug 2026: Index Value of Scheme Benchmark is 5,310.7000 and Crisil 1 Year T-bill is 8,178.7756",
        "Allotment Date: 12th January 2009",
        "Scheme Benchmark: *Nifty Liquid Index A-I",
        "Additional Benchmark: **Crisil 1 Year T-bill",
    ]
    assert "table_header_promoted" not in part.flags


def test_row_with_measures_is_not_promoted_to_header(fund_performance_doc):
    # p88 #/tables/1: after the `NAV as on` title the first row is label + value, not a header.
    part = normalized(fund_performance_doc, "#/tables/1")
    assert part.title == "NAV as on"
    assert "table_header_promoted" not in part.flags
    assert part.text.split("\n") == [
        "Index Value 31st Aug 2026: Index Value of Scheme Benchmark is 35,005.470 and BSE Sensex (TRI) is 1,21,824.500",
        "Allotment Date: 4th April 2008",
        "Scheme Benchmark: *Nifty 100 (TRI)",
        "Additional Benchmark: **BSE Sensex (TRI)",
    ]


def test_flagged_header_row_holding_measures_is_data(fund_performance_doc):
    # p88 #/tables/5: Docling marks the `Index Value` data row as column_header.
    part = normalized(fund_performance_doc, "#/tables/5")
    assert part.text.split("\n") == [
        "Index Value 31st Aug 2026: Index Value of Scheme Benchmark is 22,022.970 and BSE Sensex (TRI) is 1,21,824.500",
        "Allotment Date: 9th July 2010",
        "Scheme Benchmark: *Nifty Large Midcap 250 (TRI)",
        "Additional Benchmark: **BSE Sensex (TRI)",
    ]


def test_fund_performance_grid_keeps_triplets(fund_performance_doc):
    part = normalized(fund_performance_doc, "#/tables/0")
    lines = part.text.split("\n")
    assert lines[0] == (
        "Last 1 Year, Mirae Asset Large Cap Fund = 1.58%. Last 1 Year, Scheme Benchmark* = 1.98%. "
        "Last 1 Year, Additional Benchmark** = -2.55%"
    )


def test_header_less_cells_in_a_headed_grid():
    table = _grid(
        [
            [(0, 1, "Period", True), (2, 3, "Scheme Benchmark*", True), (3, 4, "Additional Benchmark**", True)],
            [(0, 1, "Last 7 Days", False), (1, 2, "4.93%", False), (2, 3, "5.02%", False), (3, 4, "4.13%", False)],
            [(0, 1, "NAV as on 31st Aug 2026", False), (1, 4, "₹1,402.3793", False)],
        ],
        4,
    )
    assert _lines(table) == [
        "Last 7 Days: 4.93%. Last 7 Days, Scheme Benchmark* = 5.02%. Last 7 Days, Additional Benchmark** = 4.13%",
        "NAV as on 31st Aug 2026: ₹1,402.3793",
    ]


def test_several_header_less_values_join_in_column_order():
    table = _grid(
        [
            [(0, 1, "NAV Growth", False), (1, 2, "Direct ₹17.243", False), (2, 3, "Regular ₹16.373", False)],
            [(0, 1, "NAV IDCW", False), (1, 2, "Direct ₹17.192", False), (2, 3, "Regular ₹16.379", False)],
        ],
        3,
    )
    assert _lines(table) == ["NAV Growth: Direct ₹17.243; Regular ₹16.373", "NAV IDCW: Direct ₹17.192; Regular ₹16.379"]


def test_title_row_above_header_row():
    # p91 #/tables/1: a full-width title row, then the column_header row.
    table = _grid(
        [
            [(0, 2, "Mirae Asset Midcap Fund - Fund Managers - Mr. Ankit Jain", False)],
            [(0, 1, "Period", True), (1, 2, "Mirae Asset Midcap Fund", True), (2, 3, "Scheme Benchmark*", True)],
            [(0, 1, "Last 1 Year", False), (1, 2, "16.32%", False), (2, 3, "14.13%", False)],
            [(0, 1, "NAV as on 31st Aug 2026", False), (1, 2, "₹41.212", False)],
        ],
        3,
    )
    part = tables.normalize_table(table)
    assert part.title == "Mirae Asset Midcap Fund - Fund Managers - Mr. Ankit Jain"
    assert "heading_from_table_title" in part.flags
    assert part.text.split("\n") == [
        "Last 1 Year, Mirae Asset Midcap Fund = 16.32%. Last 1 Year, Scheme Benchmark* = 14.13%",
        "NAV as on 31st Aug 2026, Mirae Asset Midcap Fund = ₹41.212",
    ]


def test_full_width_header_cell_above_header_row_is_title():
    # p107 SIP table: Docling flags the fund-name row as column_header across all columns.
    table = _grid(
        [
            [(0, 3, "Mirae Asset Long Term Fund*", True)],
            [(0, 1, "Period", True), (1, 2, "Since Inception", True), (2, 3, "1 Year", True)],
            [(0, 1, "Total Amount Invested (in Rs.)", False), (1, 2, "2,00,000", False), (2, 3, "1,20,000", False)],
        ],
        3,
    )
    part = tables.normalize_table(table)
    assert part.title == "Mirae Asset Long Term Fund*"
    # A colon inside parentheses does not make the title a `label: value` line (p93).
    etf = _grid(
        [
            [(0, 2, "Mirae Asset Nifty Financial Services ETF (NSE Symbol: BFSI) - Fund Managers - Ms. Ekta Gala", False)],
            [(0, 1, "Period", True), (1, 2, "Mirae Asset Nifty Financial Services ETF", True)],
            [(0, 1, "Last 1 Year", False), (1, 2, "3.57%", False)],
        ],
        2,
    )
    etf_part = tables.normalize_table(etf)
    assert etf_part.title.startswith("Mirae Asset Nifty Financial Services ETF (NSE Symbol: BFSI)")
    assert etf_part.text == "Last 1 Year, Mirae Asset Nifty Financial Services ETF = 3.57%"
    assert part.text == (
        "Total Amount Invested (in Rs.), Since Inception = 2,00,000. Total Amount Invested (in Rs.), 1 Year = 1,20,000"
    )


def test_label_value_first_row_is_not_a_title():
    # p38 Fund Details: a `label: value` first row, then a garbled NAV row Docling flags as header.
    table = _grid(
        [
            [(0, 3, "Date of Inception/ Allotment: 31st January 2025", False)],
            [(0, 1, "Benchmark NAV:", False), (1, 2, "Direct", True), (2, 3, "Regular", True)],
            [(0, 1, "Growth:", False), (1, 2, "₹13.063", False), (2, 3, "₹12.741", False)],
            [(0, 1, "Net AUM:", False), (2, 3, "₹5,717.045 Cr.", False)],
        ],
        3,
    )
    part = tables.normalize_table(table)
    assert part.title is None
    assert part.text.split("\n") == [
        "Date of Inception/ Allotment: 31st January 2025",
        "Benchmark NAV: Direct; Regular",
        "Growth: ₹13.063; ₹12.741",
        "Net AUM: ₹5,717.045 Cr.",
    ]


def test_row_labels_in_first_occupied_column():
    # p14 Fund Facts: column 0 is empty, row labels sit in column 1 under `Key Features`.
    table = _grid(
        [
            [(1, 2, "Key Features", True), (2, 3, "Mirae Asset Large Cap Fund", True), (3, 4, "Mirae Asset Great Consumer Fund", True)],
            [(1, 2, "Type of Scheme", False), (2, 3, "An open-ended equity scheme", False), (3, 4, "A thematic scheme", False)],
            [(0, 4, "*Investors should consult their financial advisers.", False)],
        ],
        4,
    )
    assert _lines(table) == [
        "Type of Scheme, Mirae Asset Large Cap Fund = An open-ended equity scheme. "
        "Type of Scheme, Mirae Asset Great Consumer Fund = A thematic scheme",
        "*Investors should consult their financial advisers.",
    ]


def test_header_spanning_the_label_column_names_only_that_column():
    # p95 #/tables/1: `Period <fund>` header merged across the label and first value column.
    table = _grid(
        [
            [(0, 2, "Period Mirae Asset Balanced Advantage Fund", True), (2, 3, "Scheme Benchmark*", True)],
            [(0, 1, "Last 1 Year", False), (1, 2, "6.21%", False), (2, 3, "1.38%", False)],
            [(0, 1, "NAV as on 31st Aug 2026", False), (1, 2, "₹14.766", False)],
        ],
        3,
    )
    assert _lines(table) == [
        "Last 1 Year: 6.21%. Last 1 Year, Scheme Benchmark* = 1.38%",
        "NAV as on 31st Aug 2026: ₹14.766",
    ]


def test_header_row_merged_with_first_data_row():
    # p98 #/tables/0: Docling merged `Period | Mirae Asset Multicap Fund | Scheme Benchmark* | ...`
    # with the `Last 1 Year` row; the fund name is split over the label and the next two cells.
    table = _grid(
        [
            [(0, 2, "Mirae Asset Multicap Fund - Fund Managers - Mr. Ankit Jain", True)],
            [
                (0, 2, "Period Multicap Last 1 Year", False),
                (1, 2, "Mirae", False),
                (2, 3, "Asset 7.25%", False),
                (3, 4, "Scheme Benchmark* 7.56%", False),
                (4, 5, "Additional Benchmark** -0.35%", False),
            ],
            [(0, 2, "Last 3 Years", False), (2, 3, "13.74%", False), (3, 4, "13.97%", False), (4, 5, "8.99%", False)],
            [(0, 1, "NAV as on 31st Aug 2026", False), (1, 2, "₹14.995", False)],
            [(0, 1, "Allotment Date", False), (1, 2, "21st August", False), (2, 3, "2023", False)],
        ],
        5,
    )
    part = tables.normalize_table(table)
    assert part.title == "Mirae Asset Multicap Fund - Fund Managers - Mr. Ankit Jain"
    assert part.text.split("\n") == [
        "Last 1 Year, Mirae Asset Multicap Fund = 7.25%. Last 1 Year, Scheme Benchmark* = 7.56%. "
        "Last 1 Year, Additional Benchmark** = -0.35%",
        "Last 3 Years, Mirae Asset Multicap Fund = 13.74%. Last 3 Years, Scheme Benchmark* = 13.97%. "
        "Last 3 Years, Additional Benchmark** = 8.99%",
        "NAV as on 31st Aug 2026: ₹14.995",
        "Allotment Date: 21st August; 2023",
    ]


def test_label_cell_holding_the_fund_value_is_split():
    # p91 #/tables/3, p98 #/tables/2: `Period <fund>` header and `Last 1 Year 13.13%` labels
    # both span the label and the fund column; the fund name comes from the title.
    table = _grid(
        [
            [(0, 4, "Mirae Asset Nifty Next 50 ETF (NSE Symbol: NEXT50 , BSE Scrip Code: 542922) - Fund Managers - Ms. Ekta Gala", False)],
            [(0, 2, "Period Mirae Asset Nifty Next 50 ETF", True), (2, 3, "Scheme Benchmark*", True), (3, 4, "Additional Benchmark**", True)],
            [(0, 2, "Last 1 Year 13.13%", False), (2, 3, "13.20%", False), (3, 4, "-2.55%", False)],
            [(0, 2, "Value of Rs. 10000 invested (in Rs.) Since Inception 26,149.61", False), (2, 3, "26,790.12", False), (3, 4, "20,054.61", False)],
            [(0, 1, "NAV as on 31st Aug 2026", False), (1, 4, "₹762.3604", False)],
        ],
        4,
    )
    assert _lines(table) == [
        "Last 1 Year, Mirae Asset Nifty Next 50 ETF = 13.13%. Last 1 Year, Scheme Benchmark* = 13.20%. "
        "Last 1 Year, Additional Benchmark** = -2.55%",
        "Value of Rs. 10000 invested (in Rs.) Since Inception, Mirae Asset Nifty Next 50 ETF = 26,149.61. "
        "Value of Rs. 10000 invested (in Rs.) Since Inception, Scheme Benchmark* = 26,790.12. "
        "Value of Rs. 10000 invested (in Rs.) Since Inception, Additional Benchmark** = 20,054.61",
        "NAV as on 31st Aug 2026, Mirae Asset Nifty Next 50 ETF = ₹762.3604",
    ]


def test_label_cell_value_split_under_its_own_header():
    # p98 #/tables/3: the header row is clean, only the data labels swallowed the fund value.
    table = _grid(
        [
            [(0, 1, "Period", True), (1, 2, "Mirae Asset Multi Asset Allocation Fund", True), (2, 3, "Scheme Benchmark*", True)],
            [(0, 2, "Last 1 Year 13.91%", False), (2, 3, "10.85%", False)],
        ],
        3,
    )
    assert _lines(table) == [
        "Last 1 Year, Mirae Asset Multi Asset Allocation Fund = 13.91%. Last 1 Year, Scheme Benchmark* = 10.85%"
    ]


def test_label_cell_value_split_without_title_stays_label_value():
    table = _grid(
        [
            [(0, 2, "Period Mirae Asset Nifty 50 ETF", True), (2, 3, "Scheme Benchmark*", True)],
            [(0, 2, "Last 1 Year -0.48%", False), (2, 3, "-0.43%", False)],
        ],
        3,
    )
    assert _lines(table) == ["Last 1 Year: -0.48%. Last 1 Year, Scheme Benchmark* = -0.43%"]


def test_label_spanning_columns_without_trailing_measure_is_untouched():
    table = _grid(
        [
            [(0, 1, "Period", True), (1, 2, "Fund", True), (2, 3, "Scheme Benchmark*", True)],
            [(0, 2, "Since Inception 2023", False), (2, 3, "10.85%", False)],
            [(0, 3, "Past performance may or may not be sustained, returns as of 5.5%", False)],
        ],
        3,
    )
    assert _lines(table) == [
        "Since Inception 2023, Scheme Benchmark* = 10.85%",
        "Past performance may or may not be sustained, returns as of 5.5%",
    ]


def test_fund_performance_p98_tables(fund_performance_p98_doc):
    first_lines = []
    for index in range(4):
        part = normalized(fund_performance_p98_doc, f"#/tables/{index}")
        first_lines.append(part.text.split("\n")[0])
        assert not any(" = " in line and line.split(", ")[0].startswith("Period") for line in part.text.split("\n"))
    assert first_lines == [
        "Last 1 Year, Mirae Asset Multicap Fund = 7.25%. Last 1 Year, Scheme Benchmark* = 7.56%. "
        "Last 1 Year, Additional Benchmark** = -0.35%",
        "Last 1 Year, Mirae Asset BSE Sensex ETF = -2.64%. Last 1 Year, Scheme Benchmark* = -2.55%. "
        "Last 1 Year, Additional Benchmark** = -0.35%",
        "Last 1 Year, Mirae Asset Nifty IT ETF = -9.45%. Last 1 Year, Scheme Benchmark* = -9.44%. "
        "Last 1 Year, Additional Benchmark** = -2.55%",
        "Last 1 Year, Mirae Asset Multi Asset Allocation Fund = 13.91%. Last 1 Year, Scheme Benchmark* = 10.85%. "
        "Last 1 Year, Additional Benchmark** = -2.55%",
    ]


def test_repeated_inner_header_row_rebinds_columns():
    # p103 SIP tables: Docling stacks one sub-table per fund; each repeats a `Period` header
    # row, and a younger fund's sub-table has fewer periods in the same grid columns.
    table = _grid(
        [
            [(0, 4, "Mirae Asset Large Cap Fund", True)],
            [(0, 1, "Period", True), (1, 2, "Since Inception", True), (2, 3, "15 Years", True), (3, 4, "10 Years", True)],
            [(0, 1, "Fund Return & (%)", False), (1, 2, "14.06", False), (2, 3, "13.18", False), (3, 4, "11.18", False)],
            [(0, 4, "Mirae Asset Midcap Fund", False)],
            [(0, 1, "Period", False), (1, 2, "Since Inception", False), (2, 3, "5 Years", False), (3, 4, "3 Years", False)],
            [(0, 1, "Fund Return & (%)", False), (1, 2, "15.10", False), (2, 3, "14.00", False), (3, 4, "9.50", False)],
        ],
        4,
    )
    assert _lines(table) == [
        "Fund Return & (%), Since Inception = 14.06. Fund Return & (%), 15 Years = 13.18. Fund Return & (%), 10 Years = 11.18",
        "Mirae Asset Midcap Fund",
        "Fund Return & (%), Since Inception = 15.10. Fund Return & (%), 5 Years = 14.00. Fund Return & (%), 3 Years = 9.50",
    ]
