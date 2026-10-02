import os
from pathlib import Path

import pytest
from docling_core.types.doc import DoclingDocument

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "docling"
FIXTURE_STEM = "mirae-flexi-cap-p34-35"
SCHEMA_PATH = Path(__file__).resolve().parents[1] / "contract" / "docling-parse-v1.schema.json"


def models_dir() -> Path:
    return Path(os.environ.get("DOCLING_MODELS_DIR", "/opt/docling-models"))


@pytest.fixture
def fixture_doc() -> DoclingDocument:
    """Fresh copy per test: normalizers repair the document in place."""
    return DoclingDocument.load_from_json(FIXTURES / f"{FIXTURE_STEM}.docling.json")


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
def fixture_wire(chunker) -> dict:
    from docling_service.tools.fixtures import wire_for

    return wire_for(FIXTURES / f"{FIXTURE_STEM}.docling.json", chunker)


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
