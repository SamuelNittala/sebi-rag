import os
import re

import pytest

from docling_service.tests.conftest import (
    FUND_FACTS_STEM, FUND_PERFORMANCE_STEM, GOLDEN_STEMS, FIXTURES, PASSIVE_ETF_STEM, SIP_PERFORMANCE_P103_STEM,
    SIP_PERFORMANCE_STEM, needs_tokenizer,
)
from docling_service.tools.fixtures import dump_wire

pytestmark = needs_tokenizer


def _chunks(wire, **match):
    return [c for c in wire["chunks"] if all(c[k] == v for k, v in match.items())]


def _reading_index(ref, wire_order):
    return wire_order.index(ref)


@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_golden_is_byte_identical(wires, stem):
    golden = FIXTURES / f"{stem}.wire.json"
    rendered = dump_wire(wires[stem])
    if os.environ.get("UPDATE_GOLDEN") == "1":
        golden.write_text(rendered, encoding="utf-8")
    assert golden.read_text(encoding="utf-8") == rendered


def test_every_table_in_exactly_one_chunk_and_never_mixed(fixture_wire):
    for t in range(9):
        ref = f"#/tables/{t}"
        holders = [c for c in fixture_wire["chunks"] if ref in c["itemRefs"]]
        assert len(holders) == 1, ref
        assert holders[0]["itemRefs"] == [ref]
        assert holders[0]["type"] in {"table", "key_value"}
    for chunk in fixture_wire["chunks"]:
        kinds = {ref.split("/")[1] for ref in chunk["itemRefs"]}
        expected = {"text": {"texts"}, "table": {"tables"}, "key_value": {"tables"}, "picture": {"pictures"}}
        assert kinds == expected[chunk["type"]]


def test_chunk_counts_and_reading_order(fixture_wire):
    chunks = fixture_wire["chunks"]
    assert [c["chunkIndex"] for c in chunks] == list(range(len(chunks)))
    by_type = {}
    for c in chunks:
        by_type[c["type"]] = by_type.get(c["type"], 0) + 1
    assert by_type == {"text": 11, "key_value": 3, "table": 6, "picture": 5}
    pages = [c["pages"][0] for c in chunks]
    assert pages == sorted(pages)


def test_pictures(fixture_wire):
    refs = [c["itemRefs"][0] for c in _chunks(fixture_wire, type="picture")]
    assert refs == ["#/pictures/0", "#/pictures/2", "#/pictures/3", "#/pictures/5", "#/pictures/6"]
    assert fixture_wire["diagnostics"]["droppedPictures"]["logo"] == 2
    texts = "\n".join(c["text"] for c in _chunks(fixture_wire, type="picture"))
    assert "The risk of the scheme is Very High" in texts
    assert "The risk of the benchmark is Very High" in texts
    assert "Banks: 16.61%" in texts
    assert "Absolute returns for each F.Y. last 5 years" in texts


def test_fund_details_and_dates(fixture_wire):
    [details] = [c for c in _chunks(fixture_wire, type="key_value") if c["itemRefs"] == ["#/tables/0"]]
    assert details["headings"] == ["MIRAE ASSET FLEXI CAP FUND", "Monthly Factsheet as on 31st August 2026", "Fund Details"]
    assert details["text"].count("Net AUM:") == 1
    assert "Date of Inception/ Allotment: 24th February 2023" in details["text"]
    assert "ordinal_joined" in details["flags"]
    page_one = fixture_wire["pages"][0]["text"]
    assert "31st August 2026" in page_one and "31 st" not in page_one
    assert page_one.startswith("MIRAE ASSET FLEXI CAP FUND")


def test_performance_and_holdings_are_one_table_chunk_each(fixture_wire):
    [performance] = [c for c in fixture_wire["chunks"] if c["itemRefs"] == ["#/tables/3"]]
    [holdings] = [c for c in fixture_wire["chunks"] if c["itemRefs"] == ["#/tables/4"]]
    assert performance["type"] == holdings["type"] == "table"
    assert "Returns since inception, Scheme Returns Direct (%) = 16.75%" in performance["text"]
    assert "1. ICICI Bank Ltd., %age of net assets = 5.74%" in holdings["text"]


def test_table_footnotes_become_text_chunk(fixture_wire):
    [notes] = [c for c in fixture_wire["chunks"] if "#/texts/114" in c["itemRefs"]]
    assert notes["type"] == "text"
    assert notes["itemRefs"][-1] == "#/texts/118"


def test_page_stats(fixture_wire):
    first, second = fixture_wire["pages"]
    assert (first["stats"]["tables"], first["stats"]["pictures"]) == (5, 4)
    assert (second["stats"]["tables"], second["stats"]["pictures"]) == (4, 3)
    assert first["hasTable"] and second["hasTable"]


# A column index standing in for a missing column header (`NAV as on ..., 1 = ₹94.398`).
INDEX_HEADER = re.compile(r"(?:^|, |\. )\d+ = ")


@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_no_column_index_headers(wires, stem):
    for chunk in wires[stem]["chunks"]:
        assert not INDEX_HEADER.search(chunk["text"]), chunk["text"]


def test_header_less_fund_performance_rows(wires):
    texts = [c["text"] for c in wires[FUND_PERFORMANCE_STEM]["chunks"] if c["type"] == "table"]
    lines = [line for text in texts for line in text.split("\n")]
    assert "NAV as on 31st Aug 2026: ₹94.398" in lines
    assert "Index Value 31st Aug 2026: Index Value of Scheme Benchmark is 15,036.720 and BSE Sensex (TRI) is 1,21,824.500" in lines
    assert "Allotment Date: 29th March 2011" in lines
    assert "Since Inception, Mirae Asset Great Consumer Fund = 15.65%" in "\n".join(lines)


def test_as_of_page_footer_is_kept_as_last_text_chunk(wires):
    wire = wires[FUND_FACTS_STEM]
    footer = wire["chunks"][-1]
    assert footer["type"] == "text"
    assert footer["text"] == "Data as on 31st August, 2026"
    assert footer["headings"] == []
    assert footer["pages"] == [1]
    assert footer["flags"] == ["ordinal_joined"]
    page_text = wire["pages"][0]["text"]
    assert page_text.endswith("Data as on 31st August, 2026")
    # Page numbers and other footers stay furniture.
    assert all(c["text"] not in {"10", "MIRAE ASSET INVESTMENT MANAGERS (INDIA) PRIVATE LIMITED"} for c in wire["chunks"])


def test_plain_page_footers_are_still_dropped(fixture_wire):
    texts = "\n".join(c["text"] for c in fixture_wire["chunks"])
    assert "Past Performance is not an indicator or guarantee of future results." not in texts
    assert all(not page["text"].endswith("future results.") for page in fixture_wire["pages"])


def test_page_footer_footnotes_are_kept(wires):
    # passive p34: Docling labels the scheme footnotes page_footer.
    wire = wires[PASSIVE_ETF_STEM]
    footer = wire["chunks"][-1]
    assert footer["type"] == "text"
    assert footer["headings"] == [] and footer["pages"] == [1]
    lines = footer["text"].split("\n")
    assert lines[0].startswith("Pursuant to clause 14.2.2 of Chapter 14 in SEBI master circular dated March 20, 2026")
    assert lines[1] == "^^^Pursuant to notice cum addendum no. 51/2026, a Market Maker has been added w.e.f June 19, 2026."
    assert "34" not in lines
    assert "less than 6 months" in wire["pages"][0]["text"]


def test_as_of_section_header_lands_in_a_chunk(wires):
    # passive p34: `Monthly Factsheet as on 31 July, 2026` is a section header directly followed
    # by another one, so HybridChunker puts it in no chunk.
    wire = wires[PASSIVE_ETF_STEM]
    holders = [c for c in wire["chunks"] if "Monthly Factsheet as on 31 July, 2026" in [c["text"], *c["headings"]]]
    assert holders
    assert holders[0]["type"] == "text" and holders[0]["pages"] == [1]


# Stacked SIP sub-tables: every table chunk belongs to exactly one fund (its last heading), and
# no other fund of the page appears in its rows.
@pytest.mark.parametrize("stem", (SIP_PERFORMANCE_P103_STEM, SIP_PERFORMANCE_STEM))
def test_sip_table_chunks_hold_one_fund_each(wires, stem):
    tables = [c for c in wires[stem]["chunks"] if c["type"] == "table"]
    titles = list(dict.fromkeys(c["headings"][-1] for c in tables))
    assert len(titles) == 6
    for chunk in tables:
        # Page title (19.2 pt) > as-of line > the sub-table's own title.
        assert len(chunk["headings"]) == 3 and chunk["headings"][0] == "SIP PERFORMANCE"
        assert chunk["headings"][1].startswith("Monthly Factsheet as on")
        assert "heading_from_table_title" in chunk["flags"]
        assert not any(t in chunk["text"] for t in titles if t != chunk["headings"][-1]), chunk["headings"]
        assert not any(line.startswith("Period") or ", Period = " in line for line in chunk["text"].split("\n"))


# Read off the page image (mirae-sep-2026.pdf p103): Mkt Value and Fund Return since inception per fund.
SIP_P103_SINCE_INCEPTION = {
    "Mirae Asset Large Cap Fund": ("93,15,843", "14.06"),
    "Mirae Asset Liquid Fund": ("38,24,495", "6.37"),
    "Mirae Asset Large & Midcap Fund": ("1,02,97,833", "18.59"),
    "Mirae Asset Great Consumer Fund": ("67,48,727", "15.27"),
    "Mirae Asset Ultra Short to Short Term Fund* (Erstwhile known as Mirae Asset Low Duration Fund)": ("26,60,090", "6.06"),
    "Mirae Asset Aggressive Hybrid Fund": ("26,36,046", "11.77"),
}


def test_sip_p103_values_sit_under_their_fund(wires):
    tables = [c for c in wires[SIP_PERFORMANCE_P103_STEM]["chunks"] if c["type"] == "table"]
    for fund, (market_value, fund_return) in SIP_P103_SINCE_INCEPTION.items():
        for line in (
            f"Mkt Value as on 31st Aug 2026 (in Rs.), Since Inception = {market_value}.",
            f"Fund Return & (%), Since Inception = {fund_return}.",
        ):
            holders = [c["headings"][-1] for c in tables if line in c["text"]]
            assert holders == [fund], line


# Stacked SIP sub-tables: one box per fund, not the whole table's box six times.
@pytest.mark.parametrize("stem", (SIP_PERFORMANCE_P103_STEM, SIP_PERFORMANCE_STEM))
def test_sip_part_boxes_tile_the_table_in_fund_order(wires, stem):
    import json

    docling = json.loads((FIXTURES / f"{stem}.docling.json").read_text(encoding="utf-8"))
    [prov] = docling["tables"][0]["prov"]
    table = prov["bbox"]
    assert table["coord_origin"] == "BOTTOMLEFT"
    parts = [c for c in wires[stem]["chunks"] if c["type"] == "table"]
    assert len(parts) == 6 and len({c["headings"][-1] for c in parts}) == 6
    boxes = [box for c in parts for box in c["bboxes"]]
    assert len(boxes) == 6 and all(box["page"] == prov["page_no"] for box in boxes)
    tolerance = 0.01  # rounding to 2 decimals
    for box in boxes:
        assert table["l"] - tolerance <= box["l"] < box["r"] <= table["r"] + tolerance
        assert table["b"] - tolerance <= box["b"] < box["t"] <= table["t"] + tolerance
    # Top to bottom in fund (chunk) order; vertically disjoint up to 1 pt of touching, so pairwise
    # non-overlapping.
    for upper, lower in zip(boxes, boxes[1:]):
        assert upper["t"] > lower["t"]
        assert lower["t"] <= upper["b"] + 1.0, (upper, lower)
    covered = sum(box["t"] - box["b"] for box in boxes)
    assert covered >= 0.9 * (table["t"] - table["b"])


# T18q: a chart legend below Docling's picture bbox belongs to the picture chunk, and a chart whose
# values all appear in a table on its page says so.
def test_outside_legend_is_claimed_by_the_picture_chunk(wires):
    from docling_service.tests.conftest import PASSIVE_FOF_STEM

    wire = wires[PASSIVE_FOF_STEM]
    [chart] = [c for c in wire["chunks"] if c["itemRefs"][0] == "#/pictures/8"]
    assert chart["itemRefs"] == ["#/pictures/8", "#/texts/11", "#/texts/12"]
    assert chart["text"] == (
        "Mirae Asset Nifty MidSmallcap400 Momentum Quality 100 ETF: 100.01%\nCash & Other Receivables\n-0.01%"
    )
    assert chart["flags"] == ["picture_text_recovered", "chart_unpaired", "chart_values_in_table"]
    assert chart["picture"]["pairCount"] == 0
    # The bbox now covers the legend lines below the picture.
    [box] = chart["bboxes"]
    assert box["b"] < 866.0 and box["l"] < 588.0
    others = [c for c in wire["chunks"] if c is not chart]
    assert not any({"#/texts/11", "#/texts/12"} & set(c["itemRefs"]) for c in others)
    texts = [c for c in others if c["type"] == "text"]
    assert not any("Cash & Other Receivables" in c["text"] for c in texts)
    page = wire["pages"][0]["text"].split("\n")
    assert page.count("Mirae Asset Nifty MidSmallcap400 Momentum Quality 100 ETF") == 0
    assert wire["diagnostics"]["flagCounts"]["chart_values_in_table"] == 1


@pytest.mark.parametrize("stem", GOLDEN_STEMS)
def test_values_in_table_only_on_unbound_charts(wires, stem):
    for chunk in wires[stem]["chunks"]:
        if "chart_values_in_table" in chunk["flags"]:
            assert chunk["type"] == "picture"
            assert {"chart_unpaired", "chart_multi_series_unparsed"} & set(chunk["flags"])


P14_FUNDS = ["Mirae Asset Large Cap Fund", "Mirae Asset Large & Midcap Fund", "Mirae Asset Great Consumer Fund"]


def test_fund_facts_chunks_hold_one_fund_each(wires):
    wire = wires["mirae-fund-facts-p14"]
    split = [c for c in wire["chunks"] if "table_fund_columns_split" in c["flags"]]
    funds = [c for c in split if c["headings"][-1] in P14_FUNDS]
    # budget row splits repeat the fund title on each piece
    assert list(dict.fromkeys(c["headings"][-1] for c in funds)) == P14_FUNDS
    assert all(c["type"] == "key_value" for c in split)
    for chunk in funds:
        others = [f for f in P14_FUNDS if f != chunk["headings"][-1]]
        assert not any(o in chunk["text"] for o in others)
    # each fund's boxes lie in its own column, left to right (Docling's cell boxes overlap their
    # neighbour by up to ~11 pt, so a box may reach past the neighbour's edge but not its centre)
    columns = [[c["bboxes"][0] for c in funds if c["headings"][-1] == f] for f in P14_FUNDS]
    centres = [[(b["l"] + b["r"]) / 2 for b in boxes] for boxes in columns]
    for (left, right), right_centres in zip(zip(columns, columns[1:]), centres[1:]):
        assert max(b["r"] for b in left) < min(right_centres)
        assert max((b["l"] + b["r"]) / 2 for b in left) < min(b["l"] for b in right)


def test_riskometer_inside_a_fund_table_gets_its_column_fund(wires):
    wire = wires["mirae-fund-facts-p14"]
    [riskometer] = [c for c in wire["chunks"] if c["type"] == "picture" and "risk of the benchmark" in c["text"]]
    assert riskometer["headings"][-1] == "Mirae Asset Great Consumer Fund"
