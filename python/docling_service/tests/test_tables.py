from docling_core.types.doc import DoclingDocument, TableCell, TableData, TableItem

from docling_service.normalize import tables
from docling_service.normalize.text import repair_document_ordinals
from docling_service.tests.conftest import item


def normalized(doc, ref):
    [part] = normalized_parts(doc, ref)
    return part


def normalized_parts(doc, ref):
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
    [part] = tables.normalize_table(_synthetic_table(300).tables[0])
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
    [part] = tables.normalize_table(table)
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
    [part] = tables.normalize_table(table)
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
    [part] = tables.normalize_table(table)
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
    [etf_part] = tables.normalize_table(etf)
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
    [part] = tables.normalize_table(table)
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
    [part] = tables.normalize_table(table)
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




# --- Stacked sub-tables (SIP Performance pages 103-107: Docling reads a page of per-fund tables as one) ---

FUND_ROWS = ["Total Amount Invested (in Rs.)", "Fund Return & (%)", "Scheme Benchmark", "Additional Benchmark"]


def _row(label: str, values: list[tuple[int, str]], header: bool = False) -> list[tuple[int, int, str, bool]]:
    return [(0, 1, label, header), *[(col, col + 1, text, header) for col, text in values]]


def _periods(label: str = "Period", columns: tuple[str, ...] = ("Since Inception", "5 Years", "3 Years"), header=False):
    return _row(label, [(i + 1, name) for i, name in enumerate(columns)], header)


def _fund_rows(invested: tuple[str, ...], returns: tuple[str, ...], benchmark: str, additional: str):
    return [
        _row(FUND_ROWS[0], [(i + 1, v) for i, v in enumerate(invested)]),
        _row(FUND_ROWS[1], [(i + 1, v) for i, v in enumerate(returns)]),
        _row(FUND_ROWS[2], [(1, benchmark)]),
        _row(FUND_ROWS[3], [(1, additional)]),
    ]


def _parts(rows, num_cols=4):
    return tables.normalize_table(_grid(rows, num_cols))


def test_stacked_sub_tables_become_one_part_each_with_their_own_columns():
    parts = _parts(
        [
            [(0, 1, "Mirae Asset Large Cap Fund", True)],
            _periods(header=True),
            *_fund_rows(("22,00,000", "6,00,000", "3,60,000"), ("14.06", "7.89", "4.88"), "Nifty 100 (TRI)", "BSE Sensex (TRI)"),
            [(0, 1, "Mirae Asset Midcap Fund", False)],
            _periods(columns=("Since Inception", "3 Years", "1 Year")),
            *_fund_rows(("8,50,000", "3,60,000", "1,20,000"), ("20.50", "14.02", "20.14"), "Nifty Midcap 150 Index (TRI)", "BSE Sensex (TRI)"),
        ]
    )
    assert [p.title for p in parts] == ["Mirae Asset Large Cap Fund", "Mirae Asset Midcap Fund"]
    assert all(p.kind == "table" and "heading_from_table_title" in p.flags for p in parts)
    assert parts[1].text.split("\n") == [
        "Total Amount Invested (in Rs.), Since Inception = 8,50,000. Total Amount Invested (in Rs.), 3 Years = 3,60,000. "
        "Total Amount Invested (in Rs.), 1 Year = 1,20,000",
        "Fund Return & (%), Since Inception = 20.50. Fund Return & (%), 3 Years = 14.02. Fund Return & (%), 1 Year = 20.14",
        # Full-width benchmark names are label: value, not bound to the first period column.
        "Scheme Benchmark: Nifty Midcap 150 Index (TRI)",
        "Additional Benchmark: BSE Sensex (TRI)",
    ]
    assert "Mirae Asset Midcap Fund" not in parts[0].text and "Period" not in parts[0].text


def test_a_single_period_header_table_is_not_stacked():
    [part] = _parts(
        [
            [(0, 1, "Mirae Asset Large Cap Fund", True)],
            _periods(header=True),
            *_fund_rows(("22,00,000", "6,00,000", "3,60,000"), ("14.06", "7.89", "4.88"), "Nifty 100 (TRI)", "BSE Sensex (TRI)"),
        ]
    )
    assert "Scheme Benchmark, Since Inception = Nifty 100 (TRI)" in part.text.split("\n")


def _two_funds(second_title_rows, second_body=None):
    first = [
        [(0, 1, "Mirae Asset Large Cap Fund", True)],
        _periods(header=True),
        *_fund_rows(("22,00,000", "6,00,000", "3,60,000"), ("14.06", "7.89", "4.88"), "Nifty 100 (TRI)", "BSE Sensex (TRI)"),
        [(0, 1, "Mirae Asset Liquid Fund", False)],
        _periods(),
        *_fund_rows(("21,10,000", "6,00,000", "3,60,000"), ("6.37", "6.64", "6.62"), "Nifty Liquid Index A-I", "Crisil 1 Year T-bill"),
    ]
    body = second_body or _fund_rows(("13,30,000", "6,00,000", "3,60,000"), ("11.77", "9.73", "7.35"), "CRISIL Hybrid", "BSE Sensex (TRI)")
    return _parts([*first, *second_title_rows, *body])


def test_title_fused_into_the_period_label_is_the_sub_table_title():
    # p103 Aggressive Hybrid: `Mirae Asset Aggressive Hybrid Fund Period | Since Inception | 10 Years ...`
    parts = _two_funds([_periods("Mirae Asset Aggressive Hybrid Fund Period")])
    assert parts[-1].title == "Mirae Asset Aggressive Hybrid Fund"
    assert parts[-1].text.split("\n")[0].startswith("Total Amount Invested (in Rs.), Since Inception = 13,30,000")
    assert "Period" not in parts[-1].text


def test_title_spread_over_the_period_header_cells():
    # p105 Banking and PSU: the two-line title bled into the first header cells.
    header = _row(
        "Mirae Asset Banking and PSU Debt Fund* (Erstwhile Period",
        [(1, "known as Mirae Asset Since Inception"), (2, "Banking and PSU Fund) 5 Years"), (3, "3 Years")],
    )
    parts = _two_funds([header])
    assert parts[-1].title == "Mirae Asset Banking and PSU Debt Fund* (Erstwhile known as Mirae Asset Banking and PSU Fund)"
    assert "Total Amount Invested (in Rs.), 5 Years = 6,00,000" in parts[-1].text


def test_period_header_split_over_two_rows_is_joined():
    # p106 Multicap: `Period | Since` then a label-less `Inception | 3 Years | 1 Year` row.
    parts = _two_funds(
        [
            [(0, 1, "Mirae Asset Multicap Fund", False)],
            [(0, 1, "Period", False), (1, 2, "Since", False)],
            [(1, 2, "Inception", False), (2, 3, "5 Years", False), (3, 4, "3 Years", False)],
        ]
    )
    assert parts[-1].title == "Mirae Asset Multicap Fund"
    assert parts[-1].text.split("\n")[0].startswith("Total Amount Invested (in Rs.), Since Inception = 13,30,000")


def test_first_sub_table_header_merged_into_its_first_data_row():
    # pp. 104-106: the fund name sits in the header's label cell, and `Period` plus some period
    # names (`10`, `7 Years`) were read into the `Total Amount Invested` row.
    rows = [
        [(0, 1, "Mirae Asset ELSS Tax Saver Fund", True), (1, 2, "Since Inception", True), (2, 3, "Years", True), (4, 5, "5 Years", True)],
        [(0, 1, "Period Total Amount Invested (in Rs.)", True), (1, 2, "12,80,000", True), (2, 3, "10 12,00,000", True),
         (3, 4, "7 Years 8,40,000", True), (4, 5, "6,00,000", True)],
        _row("Fund Return & (%)", [(1, "15.35"), (2, "14.99"), (3, "14.81"), (4, "11.58")]),
        [(0, 1, "Mirae Asset Liquid Fund", False)],
        _periods(columns=("Since Inception", "10 Years", "7 Years", "5 Years")),
        _row("Fund Return & (%)", [(1, "6.37"), (2, "6.01"), (3, "6.17"), (4, "6.64")]),
        [(0, 1, "Mirae Asset Midcap Fund", False)],
        _periods(columns=("Since Inception", "10 Years", "7 Years", "5 Years")),
        _row("Fund Return & (%)", [(1, "20.50"), (2, "20.43"), (3, "16.79"), (4, "14.02")]),
    ]
    parts = _parts(rows, 5)
    assert [p.title for p in parts] == ["Mirae Asset ELSS Tax Saver Fund", "Mirae Asset Liquid Fund", "Mirae Asset Midcap Fund"]
    assert parts[0].text.split("\n") == [
        "Total Amount Invested (in Rs.), Since Inception = 12,80,000. Total Amount Invested (in Rs.), 10 Years = 12,00,000. "
        "Total Amount Invested (in Rs.), 7 Years = 8,40,000. Total Amount Invested (in Rs.), 5 Years = 6,00,000",
        "Fund Return & (%), Since Inception = 15.35. Fund Return & (%), 10 Years = 14.99. "
        "Fund Return & (%), 7 Years = 14.81. Fund Return & (%), 5 Years = 11.58",
    ]


def test_fused_numbers_move_down_to_the_empty_cells_of_the_next_row():
    # p103 Large Cap: Docling put the `Mkt Value` row's values for 5Y/3Y into the row above.
    body = [
        _row("Total Amount Invested (in Rs.)", [(1, "22,00,000"), (2, "6,00,000 7,31,995"), (3, "3,60,000 3,87,712")]),
        _row("Mkt Value as on 31st Aug 2026 (in Rs.)", [(1, "93,15,843")]),
        _row("Fund Return & (%)", [(1, "11.77"), (2, "9.73"), (3, "7.35")]),
    ]
    parts = _two_funds([[(0, 1, "Mirae Asset Great Consumer Fund", False)], _periods()], body)
    assert parts[-1].text.split("\n")[:2] == [
        "Total Amount Invested (in Rs.), Since Inception = 22,00,000. Total Amount Invested (in Rs.), 5 Years = 6,00,000. "
        "Total Amount Invested (in Rs.), 3 Years = 3,60,000",
        "Mkt Value as on 31st Aug 2026 (in Rs.), Since Inception = 93,15,843. Mkt Value as on 31st Aug 2026 (in Rs.), 5 Years = 7,31,995. "
        "Mkt Value as on 31st Aug 2026 (in Rs.), 3 Years = 3,87,712",
    ]
    assert "table_cells_fused" not in parts[-1].flags


def test_fused_numbers_without_matching_empty_cells_are_kept_and_flagged():
    body = [
        _row("Total Amount Invested (in Rs.)", [(1, "22,00,000"), (2, "6,00,000 7,31,995"), (3, "3,60,000")]),
        _row("Mkt Value as on 31st Aug 2026 (in Rs.)", [(1, "93,15,843"), (2, "7,31,995"), (3, "3,87,712")]),
    ]
    parts = _two_funds([[(0, 1, "Mirae Asset Great Consumer Fund", False)], _periods()], body)
    assert "Total Amount Invested (in Rs.), 5 Years = 6,00,000 7,31,995" in parts[-1].text
    assert "table_cells_fused" in parts[-1].flags


def test_two_text_labels_fused_across_rows_are_relabelled_and_flagged():
    # p103 Ultra Short: `Scheme Benchmark Additional | <both names>` then a stray `Benchmark` row.
    body = [
        _row("Total Amount Invested (in Rs.)", [(1, "17,00,000"), (2, "6,00,000"), (3, "3,60,000")]),
        _row("Scheme Benchmark Additional", [(1, "Nifty Low Duration Debt Index A-I Crisil 10 yr Gilt index")]),
        [(0, 1, "Benchmark", False)],
    ]
    parts = _two_funds([[(0, 1, "Mirae Asset Ultra Short to Short Term Fund", False)], _periods()], body)
    lines = parts[-1].text.split("\n")
    assert lines[1:] == ["Scheme Benchmark / Additional Benchmark: Nifty Low Duration Debt Index A-I Crisil 10 yr Gilt index"]
    assert "table_cells_fused" in parts[-1].flags


def test_text_values_of_a_fused_label_pair_join_in_column_order():
    # p103 Aggressive Hybrid: `Scheme Benchmark Additional Benchmark | CRISIL Hybrid 35+65 - Aggressive BSE Sensex (TRI) | Index`
    body = [
        _row("Total Amount Invested (in Rs.)", [(1, "13,30,000"), (2, "6,00,000"), (3, "3,60,000")]),
        _row("Scheme Benchmark Additional Benchmark", [(1, "CRISIL Hybrid 35+65 - Aggressive BSE Sensex (TRI)"), (2, "Index")]),
    ]
    parts = _two_funds([_periods("Mirae Asset Aggressive Hybrid Fund Period")], body)
    assert parts[-1].text.split("\n")[-1] == (
        "Scheme Benchmark / Additional Benchmark: CRISIL Hybrid 35+65 - Aggressive BSE Sensex (TRI) Index"
    )
    assert "10 Years = Index" not in parts[-1].text


def test_numeric_and_text_labels_fused_in_one_row_are_split():
    # p104 Focused: `Add. Benchmark Return & (%) Scheme Benchmark | 9.79 Tier-1-Nifty 500 (TRI) | 9.65 | ...`
    # Row labels seen in >= 2 sub-tables are the vocabulary a fused label is split into.
    rows = [
        [(0, 1, "Mirae Asset Large Cap Fund", True)],
        _periods(header=True),
        _row("Add. Benchmark Return & (%)", [(1, "11.61"), (2, "5.87"), (3, "1.39")]),
        *_fund_rows(("22,00,000", "6,00,000", "3,60,000"), ("14.06", "7.89", "4.88"), "Nifty 100 (TRI)", "BSE Sensex (TRI)"),
        [(0, 1, "Mirae Asset Focused Fund", False)],
        _periods(),
        _row("Fund Return & (%)", [(1, "10.64"), (2, "6.92"), (3, "5.23")]),
        _row("Add. Benchmark Return & (%) Scheme Benchmark", [(1, "9.79 Tier-1-Nifty 500 (TRI)"), (2, "5.87"), (3, "1.39")]),
        _row("Additional Benchmark", [(1, "BSE Sensex (TRI)")]),
        [(0, 1, "Mirae Asset Midcap Fund", False)],
        _periods(),
        _row("Add. Benchmark Return & (%)", [(1, "9.73"), (2, "5.87"), (3, "1.39")]),
        _row("Scheme Benchmark", [(1, "Nifty Midcap 150 Index (TRI)")]),
    ]
    parts = _parts(rows)
    assert parts[1].text.split("\n") == [
        "Fund Return & (%), Since Inception = 10.64. Fund Return & (%), 5 Years = 6.92. Fund Return & (%), 3 Years = 5.23",
        "Add. Benchmark Return & (%), Since Inception = 9.79. Add. Benchmark Return & (%), 5 Years = 5.87. "
        "Add. Benchmark Return & (%), 3 Years = 1.39",
        "Scheme Benchmark: Tier-1-Nifty 500 (TRI)",
        "Additional Benchmark: BSE Sensex (TRI)",
    ]
    assert "table_cells_fused" not in parts[1].flags


def test_value_in_a_header_less_column_moves_to_the_empty_neighbouring_period():
    # p104: the grid has a column between `5 Years` and `3 Years` that only misplaced values use.
    rows = [
        [(0, 1, "Mirae Asset Short Term Fund", True)],
        _row("Period", [(1, "Since Inception"), (2, "5 Years"), (4, "3 Years")], True),
        _row("Fund Return & (%)", [(1, "5.96"), (2, "6.11"), (4, "6.02")]),
        _row("Add. Benchmark Return & (%)", [(1, "5.74"), (3, "5.95"), (4, "5.25")]),
        [(0, 1, "Mirae Asset Healthcare Fund", False)],
        _row("Period", [(1, "Since Inception"), (2, "5 Years"), (4, "3 Years")]),
        _row("Fund Return & (%)", [(1, "21.12"), (2, "20.05"), (4, "19.70")]),
    ]
    parts = _parts(rows, 5)
    assert parts[0].text.split("\n")[1] == (
        "Add. Benchmark Return & (%), Since Inception = 5.74. Add. Benchmark Return & (%), 5 Years = 5.95. "
        "Add. Benchmark Return & (%), 3 Years = 5.25"
    )


def test_body_row_repeating_the_column_headers_is_dropped():
    body = [
        _row("Fund Return & (%)", [(1, "11.77"), (2, "9.73"), (3, "7.35")]),
        _row("Mirae Asset Aggressive Hybrid Fund", [(1, "Since Inception"), (2, "5 Years"), (3, "3 Years")]),
    ]
    parts = _two_funds([[(0, 1, "Mirae Asset Aggressive Hybrid Fund", False)], _periods()], body)
    assert parts[-1].text.split("\n") == [
        "Fund Return & (%), Since Inception = 11.77. Fund Return & (%), 5 Years = 9.73. Fund Return & (%), 3 Years = 7.35",
    ]


SIP_P103_TITLES = [
    "Mirae Asset Large Cap Fund",
    "Mirae Asset Liquid Fund",
    "Mirae Asset Large & Midcap Fund",
    "Mirae Asset Great Consumer Fund",
    "Mirae Asset Ultra Short to Short Term Fund* (Erstwhile known as Mirae Asset Low Duration Fund)",
    "Mirae Asset Aggressive Hybrid Fund",
]


def test_sip_p103_six_funds(sip_p103_doc):
    parts = normalized_parts(sip_p103_doc, "#/tables/0")
    assert [p.title for p in parts] == SIP_P103_TITLES
    large_cap, _, _, consumer, ultra_short, hybrid = (p.text.split("\n") for p in parts)
    # Defect 2: Total Amount Invested and Mkt Value rows fused for 7Y-1Y.
    assert large_cap[0].endswith("Total Amount Invested (in Rs.), 7 Years = 8,40,000. Total Amount Invested (in Rs.), 5 Years = 6,00,000. "
                                 "Total Amount Invested (in Rs.), 3 Years = 3,60,000. Total Amount Invested (in Rs.), 1 Year = 1,20,000")
    assert large_cap[1] == (
        "Mkt Value as on 31st Aug 2026 (in Rs.), Since Inception = 93,15,843. Mkt Value as on 31st Aug 2026 (in Rs.), 15 Years = 52,69,180. "
        "Mkt Value as on 31st Aug 2026 (in Rs.), 10 Years = 21,44,409. Mkt Value as on 31st Aug 2026 (in Rs.), 7 Years = 12,33,168. "
        "Mkt Value as on 31st Aug 2026 (in Rs.), 5 Years = 7,31,995. Mkt Value as on 31st Aug 2026 (in Rs.), 3 Years = 3,87,712. "
        "Mkt Value as on 31st Aug 2026 (in Rs.), 1 Year = 1,20,911"
    )
    assert "Scheme Benchmark: Nifty 100 (TRI)" in large_cap
    # Defect 1: Great Consumer's rows live under its own title.
    assert consumer[1].startswith("Mkt Value as on 31st Aug 2026 (in Rs.), Since Inception = 67,48,727.")
    # Defect 3: two label rows fused; the value cannot be split safely.
    assert ultra_short[-1] == (
        "Scheme Benchmark / Additional Benchmark: Nifty Low Duration Debt Index A-I Crisil 10 yr Gilt index"
    )
    assert "Benchmark" not in ultra_short
    assert "Total Amount Invested (in Rs.), 10 Years = 12,00,000" in ultra_short[0]
    # Defect 4: inner header row with the fund name, and the benchmark split across columns.
    assert hybrid[0].startswith("Total Amount Invested (in Rs.), Since Inception = 13,30,000.")
    assert "Period" not in "\n".join(hybrid)
    assert hybrid[-1] == "Scheme Benchmark / Additional Benchmark: CRISIL Hybrid 35+65 - Aggressive BSE Sensex (TRI) Index"
    flagged = [p.title for p in parts if "table_cells_fused" in p.flags]
    assert flagged == [SIP_P103_TITLES[4], SIP_P103_TITLES[5]]


def test_sip_p104_six_funds(sip_p104_doc):
    parts = normalized_parts(sip_p104_doc, "#/tables/0")
    assert [p.title for p in parts] == [
        "Mirae Asset ELSS Tax Saver Fund",
        "Mirae Asset Dynamic Term Fund* (Erstwhile known as Mirae Asset Dynamic Bond Fund)",
        "Mirae Asset Short Term Fund* (Erstwhile known Mirae Asset Short Duration Fund)",
        "Mirae Asset Healthcare Fund",
        "Mirae Asset Equity Savings Fund",
        "Mirae Asset Focused Fund",
    ]
    elss = parts[0].text.split("\n")
    assert elss[0] == (
        "Total Amount Invested (in Rs.), Since Inception = 12,80,000. Total Amount Invested (in Rs.), 10 Years = 12,00,000. "
        "Total Amount Invested (in Rs.), 7 Years = 8,40,000. Total Amount Invested (in Rs.), 5 Years = 6,00,000. "
        "Total Amount Invested (in Rs.), 3 Years = 3,60,000. Total Amount Invested (in Rs.), 1 Year = 1,20,000"
    )
    assert elss[1].startswith("Mkt Value as on 31st Aug 2026 (in Rs.), Since Inception = 30,33,315.")
    focused = parts[5].text.split("\n")
    assert "Add. Benchmark Return & (%), 5 Years = 5.87" in focused[-3]
    assert focused[-2:] == ["Scheme Benchmark: Tier-1-Nifty 500 (TRI)", "Additional Benchmark: Tier-2-Nifty 200 (TRI) BSE Sensex (TRI)"]
    short_term = parts[2].text
    assert "Add. Benchmark Return & (%), 5 Years = 5.95" in short_term
    # `as Since Inception`: a title word bled into the header cell.
    assert "Total Amount Invested (in Rs.), Since Inception = 10,10,000." in short_term and "as Since" not in short_term
