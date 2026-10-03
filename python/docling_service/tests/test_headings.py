"""Section header levels from rendered font size (Docling gives every PDF section header level 1)."""

import pytest
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size

from docling_service.normalize import headings
from docling_service.tests.conftest import FIXTURE_STEM, FIXTURES, PASSIVE_ETF_STEM, load_doc, needs_tokenizer

PASSIVE_TITLE = "MIRAE ASSET NIFTY 500 HEALTHCARE ETF"
ACTIVE_TITLE = "MIRAE ASSET FLEXI CAP FUND"


def _prov(page: int, top: float) -> ProvenanceItem:
    box = BoundingBox(l=40, t=top, r=500, b=top + 12, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page, bbox=box, charspan=(0, 1))


def _doc(rows: list[tuple[int, str, str]]) -> DoclingDocument:
    """rows: (page, 'h' | 't', text) in reading order."""
    doc = DoclingDocument(name="synthetic")
    for page in sorted({p for p, _, _ in rows}):
        doc.add_page(page_no=page, size=Size(width=600, height=800))
    top = {}
    for page, kind, text in rows:
        top[page] = top.get(page, 20.0) + 30
        if kind == "h":
            doc.add_heading(text=text, prov=_prov(page, top[page]))
        else:
            doc.add_text(label=DocItemLabel.TEXT, text=text, prov=_prov(page, top[page]))
    return doc


def _sizes(doc: DoclingDocument, by_text: dict[str, float]) -> dict[str, float]:
    return {t.self_ref: by_text[t.text] for t in doc.texts if t.text in by_text}


def _normalize(doc, chunker, header_sizes=None):
    from docling_service.normalize.chunks import normalize_document

    return normalize_document(
        doc, chunker, producer={}, source_sha256="0" * 64, byte_size=1, conversion_ms=0, header_sizes=header_sizes,
    )


# --- size clusters -> levels -------------------------------------------------------------------


def test_size_levels_rank_clusters_largest_first_and_merge_close_sizes():
    levels = headings.size_levels([14.0, 10.0, 8.0, 7.99, 7.0, 13.99, 9.0])
    assert levels == {14.0: 1, 13.99: 1, 10.0: 2, 9.0: 3, 8.0: 4, 7.99: 4, 7.0: 5}


def test_size_levels_merge_within_tolerance_of_the_cluster_anchor_not_chained():
    # 10 -> 9.4 is within 8% of the anchor 10; 9.0 is not (chaining 9.4 -> 9.0 would merge it).
    assert headings.size_levels([10.0, 9.4, 9.0]) == {10.0: 1, 9.4: 1, 9.0: 2}


def test_single_cluster_assigns_nothing():
    doc = _doc([(1, "h", "A"), (1, "t", "a"), (1, "h", "B"), (1, "t", "b")])
    assert headings.assign_header_levels(doc, _sizes(doc, {"A": 9.0, "B": 8.8})) is False
    assert [t.level for t in doc.texts if t.label == DocItemLabel.SECTION_HEADER] == [1, 1]


def test_unknown_size_keeps_level_one():
    doc = _doc([(1, "h", "Title"), (1, "h", "Section"), (1, "h", "No chars"), (1, "t", "x")])
    assert headings.assign_header_levels(doc, _sizes(doc, {"Title": 20.0, "Section": 10.0})) is True
    assert {t.text: t.level for t in doc.texts if t.label == DocItemLabel.SECTION_HEADER} == {
        "Title": 1, "Section": 2, "No chars": 1,
    }


# --- font sizes from the PDF --------------------------------------------------------------------


def test_header_font_sizes_from_fixture_pdfs():
    doc = load_doc(PASSIVE_ETF_STEM)
    sizes = headings.header_font_sizes(doc, (FIXTURES / f"{PASSIVE_ETF_STEM}.pdf").read_bytes())
    by_text = {t.text: sizes.get(t.self_ref) for t in doc.texts if t.label == DocItemLabel.SECTION_HEADER}
    assert by_text[PASSIVE_TITLE] == pytest.approx(30.0, abs=0.1)
    assert by_text["Fund Information"] == pytest.approx(9.75, abs=0.1)
    assert by_text["Minimum Investment Amount"] == pytest.approx(8.25, abs=0.1)

    doc = load_doc(FIXTURE_STEM)
    sizes = headings.header_font_sizes(doc, (FIXTURES / f"{FIXTURE_STEM}.pdf").read_bytes())
    # The PDF draws in px under a 0.75 CTM: the rendered size includes the text matrix.
    titles = [sizes[t.self_ref] for t in doc.texts if t.text == ACTIVE_TITLE]
    assert titles == [pytest.approx(14.0, abs=0.1)] * 2
    assert all(t.self_ref in sizes for t in doc.texts if t.label == DocItemLabel.SECTION_HEADER)


def test_header_font_sizes_skip_pages_whose_size_differs():
    doc = load_doc(PASSIVE_ETF_STEM)
    doc.pages[1].size = Size(width=600, height=800)
    assert headings.header_font_sizes(doc, (FIXTURES / f"{PASSIVE_ETF_STEM}.pdf").read_bytes()) == {}


# --- chunk headings -----------------------------------------------------------------------------


@needs_tokenizer
def test_synthetic_three_sizes_give_nested_headings(chunker):
    rows = [
        (1, "h", "FUND TITLE"), (1, "t", "An open ended scheme."),
        (1, "h", "Fund Information"), (1, "t", "Allotment Date: 20th November 2018"),
        (1, "h", "Minimum Investment"), (1, "t", "Rs 5,000 and in multiples of Re 1"),
        (1, "h", "Portfolio"), (1, "t", "ICICI Bank 9.1%"),
    ]
    doc = _doc(rows)
    sizes = _sizes(doc, {"FUND TITLE": 20.0, "Fund Information": 10.0, "Minimum Investment": 8.0, "Portfolio": 10.0})
    wire = _normalize(doc, chunker, sizes)
    assert [c["headings"] for c in wire["chunks"]] == [
        ["FUND TITLE"],
        ["FUND TITLE", "Fund Information"],
        ["FUND TITLE", "Fund Information", "Minimum Investment"],
        ["FUND TITLE", "Portfolio"],
    ]


@needs_tokenizer
def test_single_size_document_is_unchanged(chunker):
    rows = [(1, "h", "FUND TITLE"), (1, "h", "Fund Information"), (1, "t", "Allotment Date: 20th November 2018")]
    plain = _normalize(_doc(rows), chunker)
    doc = _doc(rows)
    same = _normalize(doc, chunker, _sizes(doc, {"FUND TITLE": 10.0, "Fund Information": 10.0}))
    assert same == plain


@needs_tokenizer
def test_headings_from_earlier_pages_do_not_leak(chunker):
    rows = [
        (1, "h", "GLOSSARY"), (1, "t", "Terms."),
        (2, "h", "FUND TITLE"), (2, "t", "An open ended scheme."),
        (2, "h", "Fund Information"), (2, "t", "Allotment Date: 20th November 2018"),
        (3, "t", "Continued from the previous page."),
        (3, "h", "Portfolio"), (3, "t", "ICICI Bank 9.1%"),
    ]
    doc = _doc(rows)
    sizes = _sizes(doc, {"GLOSSARY": 30.0, "FUND TITLE": 20.0, "Fund Information": 10.0, "Portfolio": 10.0})
    wire = _normalize(doc, chunker, sizes)
    assert [(c["pages"], c["headings"]) for c in wire["chunks"]] == [
        ([1], ["GLOSSARY"]),
        ([2], ["FUND TITLE"]),  # not under page 1's larger GLOSSARY
        ([2, 3], ["FUND TITLE", "Fund Information"]),  # HybridChunker merges the continuation (same headings)
        ([3], ["Portfolio"]),  # page 3's own header drops page 2's title
    ]


def _unit(page: int, headings: list[str]):
    from docling_service.normalize.chunks import _Unit

    doc = _doc([(page, "t", "x")])
    return _Unit("text", [doc.texts[0]], headings, 0.0, text="x")


def test_stale_headings_continuation_and_as_of_notes():
    from docling_service.normalize.chunks import _drop_stale_headings

    as_of = "Monthly Factsheet as on 31 July, 2026"
    doc = _doc([
        (1, "h", "GLOSSARY"), (2, "h", "FUND TITLE"), (2, "h", as_of), (2, "h", "Fund Information"), (3, "h", "Portfolio"),
    ])
    units = [
        _unit(3, ["GLOSSARY", "FUND TITLE", "Fund Information"]),  # continuation on page 3
        _unit(3, ["GLOSSARY", "FUND TITLE", "Portfolio"]),
        _unit(2, ["GLOSSARY", "FUND TITLE", as_of]),  # directly below the as-of note
        _unit(2, ["GLOSSARY", "FUND TITLE", as_of, "Fund Information"]),
        _unit(2, ["Not a header text"]),  # unknown text counts as the unit's page
    ]
    _drop_stale_headings(units, doc)
    assert [u.headings for u in units] == [
        ["Fund Information"],  # a continuation keeps only its last heading, as before levels
        ["Portfolio"],
        ["FUND TITLE", as_of],
        ["FUND TITLE", "Fund Information"],
        ["Not a header text"],
    ]


@needs_tokenizer
def test_passive_p34_sections_carry_the_fund_title(wires):
    chunks = [c for c in wires[PASSIVE_ETF_STEM]["chunks"] if c["headings"]]
    assert all(c["headings"][0] == PASSIVE_TITLE for c in chunks)
    [info] = [c for c in chunks if c["type"] == "key_value" and "Fund Information" in c["headings"]]
    assert info["headings"] == [PASSIVE_TITLE, "Fund Information", "Fund Managers : Ms. Ekta Gala Mr. Ritesh Patel"]
    # 8.25 pt `Minimum Investment Amount` nests under 9.75 pt `Fund Information`.
    [minimum] = [c for c in chunks if c["headings"][-1] == "Minimum Investment Amount"]
    assert minimum["headings"] == [PASSIVE_TITLE, "Fund Information", "Minimum Investment Amount"]
    [nav] = [c for c in chunks if c["text"].startswith("₹ 21.6424")]
    assert nav["headings"][0] == PASSIVE_TITLE and nav["headings"][-1] == "Net Asset Value (NAV)"


@needs_tokenizer
def test_active_p34_35_fund_title_is_parent_of_section_headings(wires):
    chunks = [c for c in wires[FIXTURE_STEM]["chunks"] if c["headings"]]
    assert all(c["headings"][0] == ACTIVE_TITLE for c in chunks)
    [performance] = [c for c in chunks if c["type"] == "table" and c["headings"][-1] == "Fund Performance"]
    assert performance["pages"] == [1]
    [details] = [c for c in chunks if c["headings"][-1] == "Fund Details"]
    assert details["headings"] == [ACTIVE_TITLE, "Monthly Factsheet as on 31st August 2026", "Fund Details"]
    assert all("Monthly Factsheet" not in h for c in chunks for h in c["headings"][:-1] if c is not details)
    # 7 pt labels nest under the 8 pt section above them.
    lump = next(c for c in chunks if "Lump sum Amount:" in c["headings"])
    assert lump["headings"][-2:] == ["Minimum Investment", "Lump sum Amount:"]
    page_two = [c for c in chunks if c["pages"] == [2]]
    assert page_two and all(c["headings"][0] == ACTIVE_TITLE for c in page_two)


@needs_tokenizer
def test_disclaimer_header_ends_the_fund_path(chunker):
    disclaimer = "Past Performance is not an indicator or guarantee of future results."
    rows = [
        (1, "h", "FUND PERFORMANCE"), (1, "h", "Mirae Asset Large Cap Fund - Fund Managers"), (1, "t", "Last 1 Year 13.13%"),
        (1, "h", disclaimer), (1, "t", "For computation of since inception returns the allotment NAV is used."),
    ]
    doc = _doc(rows)
    sizes = _sizes(doc, {"FUND PERFORMANCE": 19.2, "Mirae Asset Large Cap Fund - Fund Managers": 6.7, disclaimer: 5.8})
    wire = _normalize(doc, chunker, sizes)
    assert [c["headings"] for c in wire["chunks"]] == [
        ["FUND PERFORMANCE", "Mirae Asset Large Cap Fund - Fund Managers"],
        [disclaimer],  # not a subsection of the fund above it
    ]


@needs_tokenizer
def test_as_of_header_opening_a_page_takes_no_headings_from_the_previous_page(chunker):
    as_of = "Monthly Factsheet as on 31 August, 2026"
    rows = [
        (1, "h", "MIRAE ASSET MULTI ASSET ALLOCATION FUND"), (1, "t", "An open ended scheme."),
        (2, "h", "FUND PERFORMANCE"), (2, "h", as_of), (2, "h", "Mirae Asset Large Cap Fund - Fund Managers"),
        (2, "t", "Last 1 Year 13.13%"),
    ]
    doc = _doc(rows)
    sizes = _sizes(doc, {
        "MIRAE ASSET MULTI ASSET ALLOCATION FUND": 14.0, "FUND PERFORMANCE": 19.2, as_of: 7.2,
        "Mirae Asset Large Cap Fund - Fund Managers": 6.7,
    })
    wire = _normalize(doc, chunker, sizes)
    assert [(c["pages"], c["headings"], c["text"]) for c in wire["chunks"]] == [
        ([1], ["MIRAE ASSET MULTI ASSET ALLOCATION FUND"], "An open ended scheme."),
        ([2], [], as_of),  # its own chunk (never a parent), not headed by page 1's fund
        ([2], ["FUND PERFORMANCE", "Mirae Asset Large Cap Fund - Fund Managers"], "Last 1 Year 13.13%"),
    ]
