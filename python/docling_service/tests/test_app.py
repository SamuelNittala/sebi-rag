import hashlib
import json

import pytest
from docling_core.types.doc import DoclingDocument

from docling_service import converter
from docling_service.app import DOCLING_PARSE_MEDIA_TYPE, create_app
from docling_service.converter import ConversionError
from docling_service.tests.conftest import FIXTURE_STEM, FIXTURES, assert_wire_contract, needs_tokenizer

PDF = (FIXTURES / f"{FIXTURE_STEM}.pdf").read_bytes()
SHA = hashlib.sha256(PDF).hexdigest()


def fixture_document(_pdf: bytes) -> DoclingDocument:
    return DoclingDocument.load_from_json(FIXTURES / f"{FIXTURE_STEM}.docling.json")


class NoChunker:
    """For error-path tests that never reach chunking."""


def client(convert=fixture_document, chunker=None, **settings):
    settings = converter.Settings(models_dir="/opt/docling-models", **settings)
    app = create_app(convert=convert, chunker=chunker or NoChunker(), settings=settings)
    return app.test_client()


def post(c, body=PDF, sha=SHA, content_type="application/pdf"):
    return c.post("/v1/parse", data=body, headers={"Content-Type": content_type, "X-Content-Sha256": sha})


def test_health_reports_versions():
    response = client().get("/health")
    assert response.status_code == 200
    body = response.get_json()
    assert body == {
        "status": "ok",
        "parserVersion": converter.parser_version(),
        "serviceVersion": "1.0.0",
        "doclingVersion": "2.132.0",
        "normalizerVersion": "1",
        "pipelineOptionsSha256": converter.pipeline_options_sha256(converter.build_pipeline_options()),
        "modelsLoaded": True,
    }


@needs_tokenizer
def test_parse_returns_validated_wire(chunker):
    response = post(client(chunker=chunker))
    assert response.status_code == 200
    assert response.headers["Content-Type"] == DOCLING_PARSE_MEDIA_TYPE
    wire = json.loads(response.data)
    assert_wire_contract(wire)
    assert wire["source"] == {"sha256": SHA, "byteSize": len(PDF)}
    assert wire["producer"]["parserVersion"] == converter.parser_version()


@pytest.mark.parametrize("sha", ["0" * 64, "", "not-hex", SHA.upper()[:10]])
def test_checksum_mismatch_is_400(sha):
    response = post(client(), sha=sha)
    assert response.status_code == 400
    assert response.get_json()["code"] == "CHECKSUM_MISMATCH"


def test_uppercase_checksum_is_accepted_case_insensitively():
    calls = []

    def convert(pdf):
        calls.append(pdf)
        raise ConversionError("DOCLING_CONVERSION_FAILED")

    response = post(client(convert=convert), sha=SHA.upper())
    assert response.status_code == 422
    assert calls == [PDF]


def test_oversize_is_413():
    response = post(client(max_upload_bytes=1000))
    assert response.status_code == 413
    assert response.get_json()["code"] == "UPLOAD_TOO_LARGE"


@pytest.mark.parametrize(
    ("body", "content_type"),
    [(PDF, "application/json"), (b"hello world", "application/pdf"), (PDF, "text/plain")],
)
def test_non_pdf_is_415(body, content_type):
    response = post(client(), body=body, sha=hashlib.sha256(body).hexdigest(), content_type=content_type)
    assert response.status_code == 415
    assert response.get_json()["code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_page_limit_is_422():
    response = post(client(max_pages=1))
    assert response.status_code == 422
    assert response.get_json()["code"] == "PDF_PAGE_LIMIT_EXCEEDED"


@pytest.mark.parametrize("code", ["DOCLING_CONVERSION_FAILED", "DOCLING_PARTIAL_CONVERSION"])
def test_conversion_failures_are_422_with_code(code):
    def convert(_pdf):
        raise ConversionError(code)

    response = post(client(convert=convert))
    assert response.status_code == 422
    assert response.get_json()["code"] == code


def test_unreadable_pdf_is_conversion_failed():
    body = b"%PDF-1.7\nnot really a pdf"
    response = post(client(), body=body, sha=hashlib.sha256(body).hexdigest())
    assert response.status_code == 422
    assert response.get_json()["code"] == "DOCLING_CONVERSION_FAILED"


@needs_tokenizer
def test_empty_document_is_422(chunker):
    def convert(_pdf):
        doc = DoclingDocument(name="empty")
        doc.add_page(page_no=1, size={"width": 595, "height": 842})
        doc.add_page(page_no=2, size={"width": 595, "height": 842})
        return doc

    response = post(client(convert=convert, chunker=chunker))
    assert response.status_code == 422
    assert response.get_json()["code"] == "EMPTY_PARSED_CONTENT"


def test_unexpected_errors_are_500_without_details():
    def convert(_pdf):
        raise RuntimeError("boom at /opt/docling-models/secret/path.py line 12")

    response = post(client(convert=convert))
    assert response.status_code == 500
    assert response.get_json() == {"code": "INTERNAL_ERROR", "message": "internal error"}
    assert b"/opt" not in response.data and b"Traceback" not in response.data


def test_unknown_route_is_json_404():
    response = client().get("/nope")
    assert response.status_code == 404
    assert response.get_json()["code"] == "NOT_FOUND"
