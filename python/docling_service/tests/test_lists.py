"""Category lists beside a left label column (passive p9 `Our Passive Fund Offerings`)."""

import pytest
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, GroupLabel, ProvenanceItem, Size

from docling_service.normalize import budget
from docling_service.normalize.lists import category_groups
from docling_service.tests.conftest import PASSIVE_OFFERINGS_STEM, needs_tokenizer

PAGE_HEIGHT = 2000.0
TITLE = "Our Passive Fund Offerings"


def _prov(left: float, top: float, right: float, height: float = 12) -> ProvenanceItem:
    # Top-left origin: `top` grows downwards.
    box = BoundingBox(l=left, t=top, r=right, b=top + height, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=1, bbox=box, charspan=(0, 1))


def _doc(categories: list[tuple[str, list[str]]], *, title: str | None = TITLE, pitch=18.0, category_gap=31.0):
    """Title on top, category headers in a left column (vertically centred on their group), one
    list in the right column whose items are `pitch` apart, `category_gap` between categories,
    all inside a form_area group as Docling reads p9."""
    doc = DoclingDocument(name="synthetic")
    doc.add_page(page_no=1, size=Size(width=900, height=PAGE_HEIGHT))
    if title:
        doc.add_heading(text=title, prov=_prov(60, 20, 300))
    form = doc.add_group(label=GroupLabel.FORM_AREA)
    tops, top = [], 80.0
    for index, (_, items) in enumerate(categories):
        if index:
            top += category_gap - pitch
        tops.append([top + i * pitch for i in range(len(items))])
        top += len(items) * pitch
    for (category, _), group_tops in zip(categories, tops):
        centre = (group_tops[0] + group_tops[-1] + 12) / 2
        doc.add_heading(text=category, prov=_prov(90, centre - 6, 270), parent=form)
    items = doc.add_list_group(parent=form)
    for (_, names), group_tops in zip(categories, tops):
        for name, item_top in zip(names, group_tops):
            doc.add_list_item(text=name, prov=_prov(375, item_top, 375 + 6 * len(name)), parent=items)
    return doc


def _names(category: str, count: int) -> list[str]:
    return [f"Mirae Asset {category} Index Number {i} ETF" for i in range(count)]


P9_LIKE = [
    ("Domestic broad based offerings", _names("Broad", 10)),
    ("Thematic offerings", _names("Theme", 15)),
    ("Smart-Beta offerings", _names("Beta", 16)),
    ("Sectorial offerings", _names("Sector", 6)),
    ("Commodities offerings", _names("Gold", 5)),
    ("Debt offerings", _names("Debt", 7)),
]


def _summary(groups):
    return [(g.title, g.category, [i.text for i in g.items]) for g in groups]


def test_list_items_are_grouped_by_gaps_under_the_label_beside_them():
    groups = category_groups(_doc(P9_LIKE))
    assert _summary(groups) == [(TITLE, category, names) for category, names in P9_LIKE]


def test_no_title_on_the_page_leaves_only_the_category():
    groups = category_groups(_doc(P9_LIKE[:2], title=None))
    assert [(g.title, g.category) for g in groups] == [(None, P9_LIKE[0][0]), (None, P9_LIKE[1][0])]


def test_even_spacing_gives_no_groups():
    # No vertical gap separates the categories: the geometry does not say which item is whose.
    assert category_groups(_doc(P9_LIKE[:3], category_gap=18.0)) == []


def test_single_header_is_not_a_label_column():
    assert category_groups(_doc(P9_LIKE[:1])) == []


def test_header_not_beside_its_group_gives_no_groups():
    doc = _doc(P9_LIKE[:2])
    second = next(t for t in doc.texts if t.text == P9_LIKE[1][0])
    second.prov[0].bbox = BoundingBox(l=90, t=60, r=270, b=72, coord_origin=CoordOrigin.TOPLEFT)  # above every item
    assert category_groups(doc) == []


def test_list_under_its_headers_is_not_a_label_column():
    # Headers stacked above a full-width list (no left column) stay as HybridChunker reads them.
    doc = _doc(P9_LIKE[:2])
    for item in doc.texts:
        if item.label == DocItemLabel.LIST_ITEM:
            item.prov[0].bbox = BoundingBox(l=100, t=item.prov[0].bbox.t, r=600, b=item.prov[0].bbox.b, coord_origin=CoordOrigin.TOPLEFT)
    assert category_groups(doc) == []


@needs_tokenizer
def test_category_chunks_carry_page_title_and_category(chunker):
    from docling_service.tools.fixtures import default_chunker  # noqa: F401  (chunker fixture builds it)
    from docling_service.normalize.chunks import normalize_document

    wire = normalize_document(_doc(P9_LIKE), chunker, producer={}, source_sha256="0" * 64, byte_size=1, conversion_ms=0)
    assert [(c["headings"], c["text"].split("\n")) for c in wire["chunks"]] == [
        ([TITLE, category], [f"- {n}" for n in names]) for category, names in P9_LIKE
    ]


@needs_tokenizer
def test_long_category_splits_between_items_repeating_title_and_category(chunker):
    from docling_service.normalize.chunks import normalize_document

    long_names = [f"Mirae Asset Very Long Thematic Index Fund Of Fund Number {i}" for i in range(80)]
    categories = [("Domestic broad based offerings", _names("Broad", 4)), ("Thematic offerings", long_names)]
    wire = normalize_document(_doc(categories), chunker, producer={}, source_sha256="0" * 64, byte_size=1, conversion_ms=0)
    chunks = wire["chunks"]
    assert chunks[0]["headings"] == [TITLE, "Domestic broad based offerings"]
    thematic = chunks[1:]
    assert len(thematic) >= 2
    assert all(c["headings"] == [TITLE, "Thematic offerings"] for c in thematic)
    assert all(budget.fits("text", c["headings"], c["text"]) for c in chunks)
    lines = [line for c in thematic for line in c["text"].split("\n")]
    assert lines == [f"- {n}" for n in long_names]  # whole items, in order, none lost or cut


@needs_tokenizer
def test_p9_golden_has_one_chunk_per_category(wires):
    chunks = [c for c in wires[PASSIVE_OFFERINGS_STEM]["chunks"] if c["headings"]]
    got = [(c["headings"], len(c["text"].split("\n"))) for c in chunks]
    assert got == [
        ([TITLE, "Domestic broad based offerings"], 10),
        ([TITLE, "Thematic offerings"], 15),
        ([TITLE, "Smart-Beta offerings"], 16),
        ([TITLE, "Sectorial offerings"], 6),
        ([TITLE, "Commodities offerings"], 5),
        ([TITLE, "Debt offerings"], 7),
    ]
    for chunk in chunks:
        assert all(line.startswith("- Mirae Asset ") for line in chunk["text"].split("\n"))
    [thematic] = [c for c in chunks if c["headings"][-1] == "Thematic offerings"]
    assert thematic["text"].split("\n")[0] == "- Mirae Asset Nifty Financial Services ETF"
    assert thematic["text"].split("\n")[-1] == "- Mirae Asset BSE India Defence ETF FOF"


@pytest.mark.parametrize("ref", ["#/texts/7", "#/texts/65"])
@needs_tokenizer
def test_p9_every_list_item_in_exactly_one_chunk(wires, ref):
    assert len([c for c in wires[PASSIVE_OFFERINGS_STEM]["chunks"] if ref in c["itemRefs"]]) == 1


def _title_page(headers: list[str]) -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    doc.add_page(page_no=1, size=Size(width=900, height=PAGE_HEIGHT))
    top = 20.0
    for header in headers:
        doc.add_heading(text=header, prov=_prov(60, top, 600))
        top += 20
    doc.add_text(label=DocItemLabel.TEXT, text="An open ended scheme replicating Nifty 50 Index", prov=_prov(60, top, 600))
    doc.add_heading(text="Fund Information", prov=_prov(60, top + 40, 600))
    doc.add_text(label=DocItemLabel.TEXT, text="Allotment Date: 20th November 2018", prov=_prov(60, top + 60, 600))
    return doc


@needs_tokenizer
def test_two_header_page_title_is_restored_as_parent_heading(chunker):
    from docling_service.normalize.chunks import normalize_document

    doc = _title_page(["MIRAE ASSET NIFTY 50 ETF", "NSE Symbol: NIFTYETF , BSE Scrip Code: 542131"])
    wire = normalize_document(doc, chunker, producer={}, source_sha256="0" * 64, byte_size=1, conversion_ms=0)
    assert [c["headings"] for c in wire["chunks"]] == [
        ["MIRAE ASSET NIFTY 50 ETF", "NSE Symbol: NIFTYETF , BSE Scrip Code: 542131"],
        ["Fund Information"],  # a later section keeps HybridChunker's headings
    ]


@pytest.mark.parametrize("headers", [
    ["ASSET ALLOCATION", "Mirae Asset Nifty 50 ETF", "Mirae Asset BSE Sensex ETF"],  # side-by-side scheme headers
    ["Monthly Factsheet as on 31 July, 2026", "NSE Symbol: NIFTYETF , BSE Scrip Code: 542131"],  # as-of ends the run
])
@needs_tokenizer
def test_other_leading_header_runs_are_left_alone(chunker, headers):
    from docling_service.normalize.chunks import normalize_document

    wire = normalize_document(_title_page(headers), chunker, producer={}, source_sha256="0" * 64, byte_size=1, conversion_ms=0)
    [description] = [c for c in wire["chunks"] if c["text"].startswith("An open ended scheme")]
    assert description["headings"] == [headers[-1]]
