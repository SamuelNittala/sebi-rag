import os

from docling_service.tests.conftest import FIXTURE_STEM, FIXTURES, needs_tokenizer
from docling_service.tools.fixtures import dump_wire

pytestmark = needs_tokenizer

GOLDEN = FIXTURES / f"{FIXTURE_STEM}.wire.json"


def _chunks(wire, **match):
    return [c for c in wire["chunks"] if all(c[k] == v for k, v in match.items())]


def _reading_index(ref, wire_order):
    return wire_order.index(ref)


def test_golden_is_byte_identical(fixture_wire):
    rendered = dump_wire(fixture_wire)
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.write_text(rendered, encoding="utf-8")
    assert GOLDEN.read_text(encoding="utf-8") == rendered


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
    assert details["headings"] == ["Monthly Factsheet as on 31st August 2026", "Fund Details"]
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
