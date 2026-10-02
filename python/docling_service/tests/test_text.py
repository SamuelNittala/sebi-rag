import pytest

from docling_service.normalize import text
from docling_service.tests.conftest import item


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Monthly Factsheet as on 31 st August 2026", "Monthly Factsheet as on 31st August 2026"),
        ("Managing Since: 3 rd April 2024", "Managing Since: 3rd April 2024"),
        ("Date of Inception/ Allotment: 24 th February 2023", "Date of Inception/ Allotment: 24th February 2023"),
        ("on 1 st Jan and 22 nd Sept", "on 1st Jan and 22nd Sept"),
    ],
)
def test_join_ordinals(raw, expected):
    assert text.join_ordinals(raw) == (expected, True)


@pytest.mark.parametrize("raw", ["31 st", "1 st Floor, Tower A", "Section 2 nd", "31st August 2026", "100 th August"])
def test_join_ordinals_leaves_non_dates(raw):
    assert text.join_ordinals(raw) == (raw, False)


def test_join_label_value_lines():
    raw = "1. Portfolio Turnover Ratio (Annualized)\na) Equity Turnover:\n40.70%\nb) Gross Exposure Turnover:\n(Equity + Debt + Derivatives)\n40.72%"
    joined, changed = text.join_label_value_lines(raw)
    assert changed is True
    assert joined.split("\n") == [
        "1. Portfolio Turnover Ratio (Annualized)",
        "a) Equity Turnover: 40.70%",
        "b) Gross Exposure Turnover:",
        "(Equity + Debt + Derivatives)",
        "40.72%",
    ]


@pytest.mark.parametrize("value", ["₹4,506.259 Cr.", "19 years", "-0.14", "$ 12", "1.5 Lakh"])
def test_join_label_value_lines_accepts_value_forms(value):
    assert text.join_label_value_lines(f"Label:\n{value}") == (f"Label: {value}", True)


def test_no_join_when_next_line_is_prose():
    raw = "Minimum Additional Application Amount:\n₹1,000/- per application and in multiples of ₹1/- thereafter."
    assert text.join_label_value_lines(raw) == (raw, False)


def test_no_join_without_trailing_colon():
    raw = "Equity Turnover\n40.70%"
    assert text.join_label_value_lines(raw) == (raw, False)


def test_repair_document_ordinals(fixture_doc):
    changed = text.repair_document_ordinals(fixture_doc)
    assert item(fixture_doc, "#/texts/7").text == "Monthly Factsheet as on 31st August 2026"
    assert item(fixture_doc, "#/texts/12").text == "Managing Since: 3rd April 2024"
    cells = [c.text for c in item(fixture_doc, "#/tables/0").data.table_cells]
    assert "Date of Inception/ Allotment: 24th February 2023" in cells
    assert changed == {"#/texts/7", "#/texts/12", "#/tables/0"}
