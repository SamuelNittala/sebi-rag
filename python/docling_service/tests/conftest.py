import os
from pathlib import Path

import pytest
from docling_core.types.doc import DoclingDocument

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "docling"
FIXTURE_STEM = "mirae-flexi-cap-p34-35"
# Single-page slices of mirae-sep-2026.pdf: p88 header-less Fund Performance rows, p10 as-of page footer.
FUND_PERFORMANCE_STEM = "mirae-fund-performance-p88"
FUND_FACTS_STEM = "mirae-fund-facts-p10"
# mirae-sep-2026.pdf p98: merged header/data rows and fund values inside row labels.
FUND_PERFORMANCE_P98_STEM = "mirae-fund-performance-p98"
# mirae-passive-aug-2026.pdf p34: page-footer footnotes, as-of line only in a section header.
PASSIVE_ETF_STEM = "mirae-passive-etf-p34"
# mirae-sep-2026.pdf p104: number-heavy SIP performance rows that need a row split under the TS token measure.
SIP_PERFORMANCE_STEM = "mirae-sip-performance-p104"
# mirae-sep-2026.pdf p103: six stacked SIP sub-tables with fused cells and a fund title inside a header row.
SIP_PERFORMANCE_P103_STEM = "mirae-sip-performance-p103"
# mirae-passive-aug-2026.pdf p9: six category headers in a left label column beside one 59-item list.
PASSIVE_OFFERINGS_STEM = "mirae-passive-offerings-p9"
# mirae-passive-aug-2026.pdf p50: two two-slice donuts (Rating Profile, Overall Asset Allocation) with leader lines.
PASSIVE_DONUTS_STEM = "mirae-passive-gsec-etf-p50"
# mirae-sep-2026.pdf p51: five- and six-slice donuts with elbow leaders and several legend entries per line.
LIQUID_DONUTS_STEM = "mirae-liquid-fund-p51"
GOLDEN_STEMS = (
    FIXTURE_STEM, FUND_PERFORMANCE_STEM, FUND_FACTS_STEM, FUND_PERFORMANCE_P98_STEM, PASSIVE_ETF_STEM, SIP_PERFORMANCE_STEM,
    SIP_PERFORMANCE_P103_STEM, PASSIVE_OFFERINGS_STEM, PASSIVE_DONUTS_STEM, LIQUID_DONUTS_STEM,
)
SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contract" / "docling-parse-v1.schema.json"


def models_dir() -> Path:
    return Path(os.environ.get("DOCLING_MODELS_DIR", "/opt/docling-models"))


def load_doc(stem: str) -> DoclingDocument:
    return DoclingDocument.load_from_json(FIXTURES / f"{stem}.docling.json")


@pytest.fixture
def fixture_doc() -> DoclingDocument:
    """Fresh copy per test: normalizers repair the document in place."""
    return load_doc(FIXTURE_STEM)


@pytest.fixture
def fund_performance_doc() -> DoclingDocument:
    return load_doc(FUND_PERFORMANCE_STEM)


@pytest.fixture
def fund_performance_p98_doc() -> DoclingDocument:
    return load_doc(FUND_PERFORMANCE_P98_STEM)


@pytest.fixture
def sip_p103_doc() -> DoclingDocument:
    return load_doc(SIP_PERFORMANCE_P103_STEM)


@pytest.fixture
def sip_p104_doc() -> DoclingDocument:
    return load_doc(SIP_PERFORMANCE_STEM)


def graphics_for(stem: str, doc: DoclingDocument) -> dict:
    """Chart graphics read from the fixture's PDF (`chart_graphics.picture_graphics`)."""
    from docling_service.normalize.chart_graphics import picture_graphics

    return picture_graphics(doc, (FIXTURES / f"{stem}.pdf").read_bytes())


def item(doc: DoclingDocument, ref: str):
    kind, index = ref.removeprefix("#/").split("/")
    return getattr(doc, kind)[int(index)]


def tokenizer_available() -> bool:
    return (models_dir() / "bge-m3-tokenizer" / "tokenizer.json").is_file()


needs_tokenizer = pytest.mark.skipif(
    not tokenizer_available(), reason="bge-m3 tokenizer not found under DOCLING_MODELS_DIR"
)


@pytest.fixture(scope="session")
def chunker():
    from docling_service.tools.fixtures import default_chunker

    return default_chunker()


@pytest.fixture(scope="session")
def wires(chunker) -> dict[str, dict]:
    from docling_service.tools.fixtures import wire_for

    return {stem: wire_for(FIXTURES / f"{stem}.docling.json", chunker) for stem in GOLDEN_STEMS}


@pytest.fixture(scope="session")
def fixture_wire(wires) -> dict:
    return wires[FIXTURE_STEM]


def assert_wire_contract(wire: dict) -> None:
    """JSON Schema plus the cross-field rules mirrored in apps/ingestion/src/parsers/docling-contract.ts."""
    import json

    from jsonschema import Draft202012Validator

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    errors = [f"{list(e.absolute_path)}: {e.message}" for e in Draft202012Validator(schema).iter_errors(wire)]
    assert not errors, errors

    producer = wire["producer"]
    assert producer["parserVersion"] == (
        f"docling-{producer['doclingVersion']}+norm-{producer['normalizerVersion']}"
        f"+opts-{producer['pipelineOptionsSha256'][:12]}"
    )
    assert len(wire["pages"]) == wire["pageCount"]
    for index, page in enumerate(wire["pages"]):
        assert page["pageNumber"] == index + 1
        assert page["hasTable"] == (page["stats"]["tables"] > 0)
    counts: dict[str, int] = {}
    for index, chunk in enumerate(wire["chunks"]):
        assert chunk["chunkIndex"] == index
        pages = chunk["pages"]
        assert pages == sorted(set(pages)) and all(1 <= p <= wire["pageCount"] for p in pages)
        for box in chunk["bboxes"]:
            assert box["page"] in pages and box["l"] < box["r"] and box["b"] < box["t"]
        headings = set(chunk["headings"])
        assert not any(line.strip() in headings for line in chunk["text"].split("\n"))
        for flag in chunk["flags"]:
            counts[flag] = counts.get(flag, 0) + 1
    assert wire["diagnostics"]["flagCounts"] == counts
