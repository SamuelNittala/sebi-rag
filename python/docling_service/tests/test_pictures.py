from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem
from docling_core.types.doc.document import (
    PictureClassificationMetaField,
    PictureClassificationPrediction,
    PictureMeta,
)

from docling_service.normalize import pictures
from docling_service.normalize.chart_graphics import Char, ChartGraphics, Mark, Raster, Stroke
from docling_service.tests.conftest import (
    FIXTURE_STEM, LIQUID_DONUTS_STEM, PASSIVE_DONUTS_STEM, graphics_for, item, load_doc,
)


def run(doc, ref, graphics=None):
    picture = item(doc, ref)
    return pictures.normalize_picture(picture, doc, (graphics or {}).get(picture.self_ref))


def run_with_pdf(stem, ref):
    doc = load_doc(stem)
    return run(doc, ref, graphics_for(stem, doc))


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


def test_asset_class_pie_without_graphics_is_unpaired(fixture_doc):
    result = run(fixture_doc, "#/pictures/6")
    assert result.flags == ("picture_text_recovered", "chart_unpaired")
    assert result.pair_count == 0
    assert result.text.split("\n") == [
        "Allocation of Net Assets by Asset Class",
        "99.42%",
        "0.58%",
        "Equity Holdings Cash & Other Receivables",
    ]


def test_fy_returns_without_graphics_is_multi_series(fixture_doc):
    result = run(fixture_doc, "#/pictures/0")
    assert result.flags == ("picture_text_recovered", "chart_multi_series_unparsed")
    lines = result.text.split("\n")
    assert lines[0] == "Absolute returns for each F.Y. last 5 years"
    assert "Regular Direct Benchmark" in lines
    assert "FYTD 27" in lines
    assert lines.count("15%") == 3


# --- colour pairing on fixture PDFs (values read off the page images) ----------


def test_sector_bars_unchanged_with_graphics():
    without = run(load_doc(FIXTURE_STEM), "#/pictures/5")
    assert run_with_pdf(FIXTURE_STEM, "#/pictures/5") == without


def test_asset_class_donut_pairs_by_colour():
    # p35: one legend line `Equity Holdings Cash & Other Receivables` with two swatches.
    result = run_with_pdf(FIXTURE_STEM, "#/pictures/6")
    assert result.text.split("\n") == [
        "Allocation of Net Assets by Asset Class",
        "Equity Holdings: 99.42%",
        "Cash & Other Receivables: 0.58%",
    ]
    assert result.flags == ("picture_text_recovered", "chart_pairs_extracted")
    assert result.pair_count == 2


def test_fy_returns_pairs_by_series_colour_and_category():
    # p34: bars coloured Regular (orange) / Direct (navy) / Benchmark (grey), category labels below.
    result = run_with_pdf(FIXTURE_STEM, "#/pictures/0")
    lines = result.text.split("\n")
    assert lines[0] == "Absolute returns for each F.Y. last 5 years"
    assert lines[1:6] == [
        "FY 23: Regular -1%; Direct -1%; Benchmark 0%",
        "FY 24: Regular 35%; Direct 37%; Benchmark 40%",
        "FY 25: Regular 7%; Direct 9%; Benchmark 6%",
        "FY 26: Regular 0%; Direct 1%; Benchmark -3%",
        "FYTD 27: Regular 15%; Direct 15%; Benchmark 15%",
    ]
    # Axis titles stay as trailing notes, the axis ticks as one last line.
    assert lines[6:] == ["Years", "^", "Returns %", "60% 40% 20% 0% -20%"]
    assert result.flags == ("picture_text_recovered", "chart_pairs_extracted")
    assert result.pair_count == 15


def test_passive_rating_profile_donuts_pair_by_colour():
    # passive p50: 95.92% orange slice, 4.08% navy slice; legend SOV (orange), Cash & Other Receivables (navy).
    rating = run_with_pdf(PASSIVE_DONUTS_STEM, "#/pictures/9")
    assert rating.text.split("\n") == ["SOV: 95.92%", "Cash & Other Receivables: 4.08%"]
    assert rating.flags == ("picture_text_recovered", "chart_pairs_extracted")
    allocation = run_with_pdf(PASSIVE_DONUTS_STEM, "#/pictures/11")
    assert allocation.text.split("\n") == ["Government Bond: 95.92%", "Cash & Other Receivables: 4.08%"]
    assert allocation.pair_count == 2


def test_liquid_fund_donuts_pair_through_elbow_leaders():
    # active p51: values sit at the end of elbow leader lines; the 0.25% slice is a 0.5 pt sliver.
    credit = run_with_pdf(LIQUID_DONUTS_STEM, "#/pictures/1")
    assert credit.text.split("\n") == [
        "Allocation of Net Assets by Credit Rating",
        "A1+: 74.21%",
        "Corporate Debt Market Development Fund: 0.25%",
        "SOV: 17.46%",
        "AAA: 3.69%",
        "Cash & Other Receivables: 4.39%",
    ]
    assert credit.flags == ("picture_text_recovered", "chart_pairs_extracted")
    asset = run_with_pdf(LIQUID_DONUTS_STEM, "#/pictures/2")
    assert asset.text.split("\n") == [
        "Allocation of Net Assets by Asset Class",
        "Commercial Paper: 49.21%",
        "Corporate Debt Market Development Fund: 0.25%",
        "Certificate Of Deposit: 25.00%",
        "Corporate Bond: 3.69%",
        "Treasury Bill: 17.46%",
        "Cash & Other Receivables: 4.39%",
    ]
    assert asset.pair_count == 6


# --- synthetic colour charts ---------------------------------------------------

ORANGE, NAVY, GREY = (227, 117, 0), (33, 70, 119), (158, 158, 158)


def _rect(rgb, l, b, r, t, z=0):
    return Mark(rgb, (l, b, r, t), (((l, b), (r, b), (r, t), (l, t)),), False, z)


def _chars(text, l, b, size=6.0, weight=400):
    """One Char per non-space character, `size` * 0.5 wide."""
    out, x = [], l
    for ch in text:
        if ch != " ":
            out.append(Char(ch, (x, b, x + size * 0.5, b + size), size, weight))
        x += size * 0.5
    return out


def _legend_pie(slices, *, legend_colours=None, title=None, leaders=True):
    """A pie of square `slices` [(label, value, rgb)] at y 100-200, legend at y 20, values right
    of their slice (or at the end of a leader line)."""
    children, marks, swatches, strokes, chars = [], [], [], [], []
    if title:
        children.append((title, (10, 280, 10 + 3 * len(title), 288)))
        chars += _chars(title, 10, 280, size=8.0, weight=700)
    for i, (label, value, rgb) in enumerate(slices):
        y = 100 + i * 30
        marks.append(_rect(rgb, 100, y, 160, y + 25, z=i))
        if leaders:
            strokes.append(Stroke((0, 0, 0), (150, y + 12, 200, y + 12), (((150, y + 12), (200, y + 12)),)))
            children.append((value, (202, y + 10, 220, y + 15)))
        else:
            children.append((value, (120, y + 10, 140, y + 15)))
        x = 10 + i * 90
        swatch = (legend_colours or [s[2] for s in slices])[i]
        swatches.append(_rect(swatch, x, 20, x + 5, 25, z=10 + i))
        children.append((label, (x + 8, 20, x + 8 + 3 * len(label), 26)))
        chars += _chars(label, x + 8, 20)
    doc, pic = _picture(children, classification="pie_chart")
    return doc, pic, ChartGraphics((0, 0, 300, 300), tuple(marks + swatches), tuple(strokes), tuple(chars))


def test_synthetic_colour_pairs_follow_leaders():
    doc, pic, graphics = _legend_pie([("Alpha", "60%", ORANGE), ("Beta", "40%", NAVY)])
    result = pictures.normalize_picture(pic, doc, graphics)
    assert result.text == "Alpha: 60%\nBeta: 40%"
    assert result.flags == ("picture_text_recovered", "chart_pairs_extracted")


def test_synthetic_values_inside_their_slice():
    doc, pic, graphics = _legend_pie([("Alpha", "60%", ORANGE), ("Beta", "40%", NAVY)], leaders=False)
    assert pictures.normalize_picture(pic, doc, graphics).text == "Alpha: 60%\nBeta: 40%"


def test_synthetic_title_line_is_not_a_label():
    # A bold, larger line above every value, mark and legend entry is the chart's title.
    doc, pic, graphics = _legend_pie([("Alpha", "60%", ORANGE), ("Beta", "40%", NAVY)], title="Rating Profile")
    result = pictures.normalize_picture(pic, doc, graphics)
    assert result.text == "Rating Profile\nAlpha: 60%\nBeta: 40%"


def test_synthetic_legend_colours_too_close_are_unpaired():
    doc, pic, graphics = _legend_pie(
        [("Alpha", "60%", ORANGE), ("Beta", "40%", (225, 119, 4))],
    )
    result = pictures.normalize_picture(pic, doc, graphics)
    assert result.flags == ("picture_text_recovered", "chart_unpaired")
    assert result.text == "60%\nAlpha\n40%\nBeta"


def test_synthetic_two_values_on_one_colour_are_unpaired():
    # Beta's legend swatch has no slice of its colour: both values sit on orange slices.
    doc, pic, graphics = _legend_pie(
        [("Alpha", "60%", ORANGE), ("Beta", "40%", ORANGE)], legend_colours=[ORANGE, NAVY],
    )
    assert pictures.normalize_picture(pic, doc, graphics).flags == ("picture_text_recovered", "chart_unpaired")


def test_synthetic_colour_pairs_over_100_percent_are_unpaired():
    doc, pic, graphics = _legend_pie([("Alpha", "70%", ORANGE), ("Beta", "40%", NAVY)])
    assert pictures.normalize_picture(pic, doc, graphics).flags == ("picture_text_recovered", "chart_unpaired")


def test_synthetic_leader_ending_on_a_slice_edge_is_unpaired():
    doc, pic, graphics = _legend_pie([("Alpha", "60%", ORANGE), ("Beta", "40%", NAVY)])
    # Slices now touch at y = 130 and Alpha's leader ends on that shared edge.
    marks = (
        _rect(ORANGE, 100, 100, 160, 130, z=0), _rect(NAVY, 100, 130, 160, 155, z=1), *graphics.marks[2:],
    )
    strokes = (Stroke((0, 0, 0), (150, 130, 200, 130), (((150, 130), (200, 112)),)), graphics.strokes[1])
    graphics = ChartGraphics(graphics.box, marks, strokes, graphics.chars)
    assert pictures.normalize_picture(pic, doc, graphics).flags == ("picture_text_recovered", "chart_unpaired")


def test_synthetic_raster_fallback_pairs_by_sampled_colour():
    # No vector marks (an embedded image): colours are sampled from the rendered region.
    doc, pic, vector = _legend_pie([("Alpha", "60%", ORANGE), ("Beta", "40%", NAVY)], leaders=False)
    width = height = 300
    pixels = bytearray(b"\xff" * width * height * 3)
    for mark in vector.marks:
        l, b, r, t = (int(v) for v in mark.box)
        for y in range(height - t, height - b):
            for x in range(l, r):
                pixels[(y * width + x) * 3 : (y * width + x) * 3 + 3] = bytes(mark.rgb)
    raster = Raster(width, height, bytes(pixels), (0.0, 300.0), 1.0)
    graphics = ChartGraphics(vector.box, (), (), vector.chars, raster)
    result = pictures.normalize_picture(pic, doc, graphics)
    assert result.text == "Alpha: 60%\nBeta: 40%"


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
