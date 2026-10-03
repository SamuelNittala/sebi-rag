"""Page header/footer rules: kept by default; page numbers, boilerplate and running lines dropped."""

from docling_core.types.doc import BoundingBox, ContentLayer, DocItemLabel, DoclingDocument, ProvenanceItem, Size

from docling_service.normalize.chunks import kept_page_furniture

FOOTNOTE = (
    "Pursuant to clause 14.2.2 of Chapter 14 in SEBI master circular dated March 20, 2026, the scheme is in "
    "existence for less than 6 months, hence performance shall not be provided."
)
ADDENDUM = "^^Pursuant to notice cum addendum no. 37/2026, a Market Maker has been added w.e.f May 04, 2026."


def _doc(pages: int, footers: dict[int, list[str]]) -> DoclingDocument:
    doc = DoclingDocument(name="synthetic")
    for page in range(1, pages + 1):
        doc.add_page(page_no=page, size=Size(width=600, height=800))
        doc.add_text(label=DocItemLabel.TEXT, text=f"Body of page {page}", prov=_prov(page, 400))
        for index, text in enumerate(footers.get(page, [])):
            doc.add_text(
                label=DocItemLabel.PAGE_FOOTER, text=text, prov=_prov(page, 60 - 10 * index),
                content_layer=ContentLayer.FURNITURE,
            )
    return doc


def _prov(page: int, top: float) -> ProvenanceItem:
    return ProvenanceItem(page_no=page, bbox=BoundingBox(l=10, t=top, r=500, b=top - 8), charspan=(0, 1))


def _kept(doc: DoclingDocument) -> list[tuple[int, str]]:
    return [(t.prov[0].page_no, t.text) for t in kept_page_furniture(doc)]


def test_full_document_keeps_footnotes_and_drops_running_lines():
    footers: dict[int, list[str]] = {}
    for page in range(1, 21):
        footers[page] = [str(page), "MIRAE ASSET INVESTMENT MANAGERS (INDIA) PRIVATE LIMITED"]
        if page <= 12:
            footers[page].append("Past Performance is not an indicator or guarantee of future results.")
        if page in (14, 15, 16):
            footers[page].append("Data as on 31st August, 2026")
    footers[4] += [FOOTNOTE, "MIRAE ASSET NIFTY 50 ETF"]
    footers[5] += [FOOTNOTE, ADDENDUM, "MIRAE ASSET NIFTY 50 ETF"]
    footers[6] += [FOOTNOTE, "MIRAE ASSET NIFTY 100 ETF"]
    footers[7] += ["34 MIRAE ASSET NIFTY 500 HEALTHCARE ETF"]
    assert _kept(_doc(20, footers)) == [
        (4, FOOTNOTE),
        (5, FOOTNOTE),
        (5, ADDENDUM),
        (6, FOOTNOTE),
        (7, "34 MIRAE ASSET NIFTY 500 HEALTHCARE ETF"),
        (14, "Data as on 31st August, 2026"),
        (15, "Data as on 31st August, 2026"),
        (16, "Data as on 31st August, 2026"),
    ]


def test_single_page_keeps_everything_but_page_numbers_and_boilerplate():
    # A one-page conversion cannot see repetition: only page numbers and the boilerplate list go.
    doc = _doc(1, {1: [
        "34",
        "Page 3 of 10",
        "MIRAE ASSET INVESTMENT MANAGERS (INDIA) PRIVATE LIMITED",
        "MUTUAL FUND FACTSHEET",
        "Past Performance is not an indicator or guarantee of future results.",
        FOOTNOTE,
        "MIRAE ASSET NIFTY 500 HEALTHCARE ETF",
    ]})
    assert _kept(doc) == [(1, FOOTNOTE), (1, "MIRAE ASSET NIFTY 500 HEALTHCARE ETF")]


def test_as_of_header_is_checked_per_page():
    # The same `Monthly Factsheet as on ...` header on every scheme page: a heading on page 1
    # does not cover page 2's copy.
    from docling_service.normalize.chunks import _as_of_header_units

    doc = DoclingDocument(name="synthetic")
    for page in (1, 2):
        doc.add_page(page_no=page, size=Size(width=600, height=800))
        doc.add_heading(text="Monthly Factsheet as on 31 July, 2026", prov=_prov(page, 700))
    order = {item.self_ref: i for i, (item, _) in enumerate(doc.iterate_items(with_groups=False))}
    chunks = [{"text": "Body", "headings": ["Monthly Factsheet as on 31 July, 2026"], "pages": [1]}]
    units = _as_of_header_units(doc, order, chunks)
    assert [u.items[0].prov[0].page_no for u in units] == [2]
