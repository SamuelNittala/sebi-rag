"""Real conversion of the fixture PDF with the baked models (Docker `test` target).

Asserts invariants only, not byte equality with the golden: model numerics can
differ by platform. Skipped unless DOCLING_MODELS_DIR holds the models.
"""

import hashlib
import time

import pytest

from docling_service import converter
from docling_service.normalize.chunks import normalize_document
from docling_service.normalize.chart_graphics import picture_graphics
from docling_service.normalize.headings import header_font_sizes
from docling_service.tests.conftest import FIXTURE_STEM, FIXTURES, assert_wire_contract, models_dir

LAYOUT_DIR = "docling-project--docling-layout-heron"

pytestmark = [
    pytest.mark.models,
    pytest.mark.skipif(not (models_dir() / LAYOUT_DIR).is_dir(), reason="Docling models not found under DOCLING_MODELS_DIR"),
]


def test_models_dir_has_no_vlm_weights():
    names = [p.name.lower() for p in models_dir().iterdir()]
    assert not [n for n in names if any(v in n for v in ("vlm", "granite", "smoldocling", "codeformula", "ocr"))]


def test_real_conversion_invariants(chunker):
    pdf = (FIXTURES / f"{FIXTURE_STEM}.pdf").read_bytes()
    settings = converter.Settings.from_env()
    docling = converter.get_converter(settings)
    started = time.perf_counter()
    document = converter.convert_pdf(docling, pdf)
    elapsed = time.perf_counter() - started
    print(f"converted {len(document.pages)} pages in {elapsed:.2f}s ({elapsed / len(document.pages):.2f} s/page)")

    wire = normalize_document(
        document,
        chunker,
        producer=converter.producer(),
        source_sha256=hashlib.sha256(pdf).hexdigest(),
        byte_size=len(pdf),
        conversion_ms=round(elapsed * 1000),
        header_sizes=header_font_sizes(document, pdf),
        chart_graphics=picture_graphics(document, pdf),
    )
    assert_wire_contract(wire)
    assert wire["pageCount"] == 2
    chunks = wire["chunks"]
    assert len([c for c in chunks if c["type"] in {"table", "key_value"}]) == 9
    assert sum("riskometer_text_extracted" in c["flags"] for c in chunks) == 2
    [sectors] = [c for c in chunks if c["text"].startswith("Allocation of Net Assets by Sectors")]
    assert "chart_pairs_extracted" in sectors["flags"] and "Banks: 16.61%" in sectors["text"]
    [details] = [c for c in chunks if c["type"] == "key_value" and "Net AUM:" in c["text"]]
    assert details["text"].count("Net AUM:") == 1
