from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem
from docling_core.types.doc.document import (
    PictureClassificationMetaField,
    PictureClassificationPrediction,
    PictureMeta,
)

from docling_service.normalize import pictures
from docling_service.tests.conftest import item


def run(doc, ref):
    return pictures.normalize_picture(item(doc, ref), doc)


def test_logos_without_text_count_as_logo(fixture_doc):
    for ref in ("#/pictures/1", "#/pictures/4"):
        result = run(fixture_doc, ref)
        assert result.dropped == "logo"


def test_scheme_riskometer(fixture_doc):
    result = run(fixture_doc, "#/pictures/2")
    assert result.dropped is None
    assert result.text == "Scheme Riskometer\nThe risk of the scheme is Very High"
    assert result.flags == ("picture_text_recovered", "riskometer_text_extracted")
    assert result.classification == "pie_chart"
    assert result.pair_count == 0


def test_benchmark_riskometer_keeps_benchmark_name(fixture_doc):
    result = run(fixture_doc, "#/pictures/3")
    assert result.text == "Benchmark Riskometer\nNifty 500 (TRI)\nThe risk of the benchmark is Very High"
    assert "riskometer_text_extracted" in result.flags


def test_sector_bars_pair_with_merged_item_split(fixture_doc):
    result = run(fixture_doc, "#/pictures/5")
    lines = result.text.split("\n")
    assert lines[0] == "Allocation of Net Assets by Sectors"
    assert lines[1] == "Banks: 16.61%"
    assert "Pharmaceuticals & Biotechnology: 6.79%" in lines
    assert "Insurance: 3.44%" in lines
    assert "Others: 39.39%" in lines
    assert lines[-1] == "Industrywise classification as recommended by AMFI"
    assert not any("10% 20%" in line for line in lines)
    assert result.pair_count == 11
    assert result.flags == ("picture_text_recovered", "chart_pairs_extracted")
    assert result.classification == "bar_chart"
    assert result.confidence > 0.99


def test_asset_class_pie_with_merged_legend_is_unpaired(fixture_doc):
    result = run(fixture_doc, "#/pictures/6")
    assert result.flags == ("picture_text_recovered", "chart_unpaired")
    assert result.pair_count == 0
    assert result.text.split("\n") == [
        "Allocation of Net Assets by Asset Class",
        "99.42%",
        "0.58%",
        "Equity Holdings Cash & Other Receivables",
    ]


def test_fy_returns_is_multi_series(fixture_doc):
    result = run(fixture_doc, "#/pictures/0")
    assert result.flags == ("picture_text_recovered", "chart_multi_series_unparsed")
    lines = result.text.split("\n")
    assert lines[0] == "Absolute returns for each F.Y. last 5 years"
    assert "Regular Direct Benchmark" in lines
    assert "FYTD 27" in lines
    assert lines.count("15%") == 3


# --- synthetic pictures -------------------------------------------------------


def _picture(children, classification="bar_chart", confidence=0.9):
    doc = DoclingDocument(name="synthetic")
    doc.add_page(page_no=1, size={"width": 600, "height": 800})
    pic = doc.add_picture(prov=_prov(0, 0, 300, 300))
    if classification:
        pic.meta = PictureMeta(
            classification=PictureClassificationMetaField(
                predictions=[PictureClassificationPrediction(class_name=classification, confidence=confidence)]
            )
        )
    for text, (l, b, r, t), *label in children:
        doc.add_text(label=label[0] if label else DocItemLabel.TEXT, text=text, prov=_prov(l, b, r, t), parent=pic)
    return doc, pic


def _prov(l, b, r, t):
    return ProvenanceItem(
        page_no=1,
        bbox=BoundingBox(l=l, t=t, r=r, b=b, coord_origin=CoordOrigin.BOTTOMLEFT),
        charspan=(0, 0),
    )


def _bars(rows):
    children = [("Chart title", (10, 290, 100, 298), DocItemLabel.SECTION_HEADER)]
    for i, (label, value) in enumerate(rows):
        y = 250 - i * 12
        children.append((label, (10, y, 60, y + 6)))
        if value is not None:
            children.append((value, (70, y + 0.5, 90, y + 5.5)))
    return children


def test_synthetic_bars_pair():
    doc, pic = _picture(_bars([("Alpha", "60%"), ("Beta", "40%")]))
    result = pictures.normalize_picture(pic, doc)
    assert result.text == "Chart title\nAlpha: 60%\nBeta: 40%"
    assert result.pair_count == 2


def test_label_without_value_is_unpaired():
    doc, pic = _picture(_bars([("Alpha", "60%"), ("Beta", None), ("Gamma", "30%")]))
    result = pictures.normalize_picture(pic, doc)
    assert result.flags == ("picture_text_recovered", "chart_unpaired")
    assert result.text == "Chart title\nAlpha\n60%\nBeta\nGamma\n30%"


def test_percentages_over_100_are_unpaired():
    doc, pic = _picture(_bars([("Alpha", "70%"), ("Beta", "40%")]))
    result = pictures.normalize_picture(pic, doc)
    assert result.flags == ("picture_text_recovered", "chart_unpaired")
    assert result.pair_count == 0


def test_picture_without_text_is_dropped():
    doc, pic = _picture([], classification="photograph")
    assert pictures.normalize_picture(pic, doc).dropped == "noText"


def test_signature_and_codes_are_dropped_even_with_text():
    for cls, key in (("signature", "signature"), ("stamp", "stamp"), ("qr_code", "qrCode"), ("bar_code", "barCode")):
        doc, pic = _picture([("John Doe", (10, 10, 50, 20))], classification=cls)
        assert pictures.normalize_picture(pic, doc).dropped == key


def test_plain_picture_text_has_no_outcome_flag():
    doc, pic = _picture([("Step one", (10, 200, 60, 210)), ("Step two", (10, 100, 60, 110))], classification="flow_chart")
    result = pictures.normalize_picture(pic, doc)
    assert result.text == "Step one\nStep two"
    assert result.flags == ("picture_text_recovered",)


def test_unclassified_picture():
    doc, pic = _picture([("Some text", (10, 10, 50, 20))], classification=None)
    result = pictures.normalize_picture(pic, doc)
    assert (result.classification, result.confidence) == ("unknown", 0.0)


def test_riskometer_dial_labels_are_discarded():
    doc, pic = _picture(
        [
            ("Scheme Riskometer", (10, 290, 100, 298), DocItemLabel.SECTION_HEADER),
            ("Very igh", (10, 200, 40, 206)),
            ("Low Risk", (60, 200, 90, 206)),
            ("The risk of the scheme is Moderately High", (10, 100, 120, 106)),
        ],
        classification="pie_chart",
    )
    result = pictures.normalize_picture(pic, doc)
    assert result.text == "Scheme Riskometer\nThe risk of the scheme is Moderately High"
