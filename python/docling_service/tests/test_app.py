import hashlib
import json
import socket
import threading
import time

import pytest
from docling_core.types.doc import DoclingDocument

from docling_service import app as app_module
from docling_service import converter
from docling_service.app import DOCLING_PARSE_MEDIA_TYPE, client_disconnected, create_app
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


def post(c, body=PDF, sha=SHA, content_type="application/pdf", **kwargs):
    headers = {"Content-Type": content_type, "X-Content-Sha256": sha}
    return c.post("/v1/parse", data=body, headers=headers, **kwargs)


def test_health_reports_versions():
    response = client().get("/health")
    assert response.status_code == 200
    body = response.get_json()
    assert body == {
        "status": "ok",
        "parserVersion": converter.parser_version(),
        "serviceVersion": "1.0.0",
        "doclingVersion": "2.132.0",
        "normalizerVersion": "5",
        "pipelineOptionsSha256": converter.pipeline_options_sha256(converter.build_pipeline_options()),
        "modelsLoaded": True,
        "busy": False,
        "activeForMs": None,
        "queuedRequests": 0,
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


class BlockingConverter:
    """Fake slow conversion: blocks until released, records peak concurrency."""

    def __init__(self):
        self.release = threading.Event()
        self.started = threading.Semaphore(0)
        self.lock = threading.Lock()
        self.running = 0
        self.peak = 0
        self.calls = 0

    def __call__(self, _pdf):
        with self.lock:
            self.running += 1
            self.calls += 1
            self.peak = max(self.peak, self.running)
        self.started.release()
        try:
            assert self.release.wait(10), "test never released the conversion"
            time.sleep(0.02)
        finally:
            with self.lock:
                self.running -= 1
        raise ConversionError("DOCLING_CONVERSION_FAILED")


def start_parse(c, results, **kwargs):
    thread = threading.Thread(target=lambda: results.append(post(c, **kwargs)))
    thread.start()
    return thread


def wait_until(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition not reached"
        time.sleep(0.01)


def health(c):
    return c.get("/health").get_json()


def test_health_answers_quickly_while_a_parse_converts():
    slow = BlockingConverter()
    c = client(convert=slow)
    results = []
    thread = start_parse(c, results)
    assert slow.started.acquire(timeout=5)
    try:
        time.sleep(0.05)
        started = time.perf_counter()
        response = c.get("/health")
        assert time.perf_counter() - started < 1.0
        assert response.status_code == 200
        body = response.get_json()
        assert body["status"] == "ok"
        assert body["parserVersion"] == converter.parser_version()
        assert body["busy"] is True
        assert body["activeForMs"] >= 50
        assert body["queuedRequests"] == 0
    finally:
        slow.release.set()
        thread.join(10)
    assert results[0].status_code == 422
    assert health(c)["busy"] is False


def test_concurrent_parses_never_convert_concurrently_and_queue():
    slow = BlockingConverter()
    c = client(convert=slow)
    results = []
    threads = [start_parse(c, results)]
    assert slow.started.acquire(timeout=5)
    threads += [start_parse(c, results) for _ in range(2)]
    wait_until(lambda: health(c)["queuedRequests"] == 2)
    assert slow.calls == 1
    slow.release.set()
    for thread in threads:
        thread.join(10)
    assert [r.status_code for r in results] == [422, 422, 422]
    assert slow.calls == 3
    assert slow.peak == 1
    assert health(c) | {"parserVersion": None} == health(client()) | {"parserVersion": None}


def test_parse_beyond_thread_capacity_is_retryable_503():
    slow = BlockingConverter()
    c = client(convert=slow, http_threads=3)  # 2 parse slots, 1 reserved for /health
    results = []
    threads = [start_parse(c, results)]
    assert slow.started.acquire(timeout=5)
    threads.append(start_parse(c, results))
    wait_until(lambda: health(c)["queuedRequests"] == 1)
    try:
        response = post(c)
        assert response.status_code == 503
        assert response.get_json() == {"code": "DOCLING_BUSY", "message": "the Docling service is at capacity"}
    finally:
        slow.release.set()
        for thread in threads:
            thread.join(10)
    assert sorted(r.status_code for r in results) == [422, 422]


def test_queued_request_whose_client_left_is_not_converted(monkeypatch):
    monkeypatch.setattr(app_module, "QUEUE_POLL_S", 0.02)
    slow = BlockingConverter()
    c = client(convert=slow)
    results = []
    first = start_parse(c, results)
    assert slow.started.acquire(timeout=5)
    server_side, client_side = socket.socketpair()
    client_side.close()
    try:
        response = post(c, environ_base={"gunicorn.socket": server_side})
        assert response.status_code == 499
        assert response.get_json()["code"] == "CLIENT_CLOSED_REQUEST"
        assert health(c)["queuedRequests"] == 0
    finally:
        slow.release.set()
        first.join(10)
        server_side.close()
    assert slow.calls == 1


def test_client_disconnected_detects_closed_peer_only():
    assert client_disconnected({}) is False
    server_side, client_side = socket.socketpair()
    try:
        assert client_disconnected({"gunicorn.socket": server_side}) is False
        client_side.sendall(b"x")  # unread pipelined bytes are not a disconnect
        assert client_disconnected({"gunicorn.socket": server_side}) is False
        server_side.recv(1)
        client_side.close()
        assert client_disconnected({"gunicorn.socket": server_side}) is True
    finally:
        server_side.close()
    assert client_disconnected({"gunicorn.socket": server_side}) is True
