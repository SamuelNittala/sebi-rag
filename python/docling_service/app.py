"""HTTP boundary: GET /health, POST /v1/parse (raw PDF bytes -> wire JSON v1).

Run: gunicorn -k gthread -w 1 --threads 12 -b 0.0.0.0:8090 --timeout 3600 'docling_service.app:create_app()'
One process holds the models; threads let /health answer while a parse converts.
ConversionGate keeps conversions strictly one at a time (memory, and the shared
Docling converter and chunker are not used concurrently); other parses queue.
A conversion in progress cannot be cancelled; a queued parse whose client has
disconnected is dropped before it converts.
Error bodies are {code, message} with static messages: never paths or stack traces.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import select
import socket
import threading
import time
from typing import Callable

from docling_core.types.doc import DoclingDocument
from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

from docling_service import converter
from docling_service.normalize.chunks import EmptyParsedContent, build_chunker, normalize_document
from docling_service.normalize.headings import header_font_sizes

DOCLING_PARSE_MEDIA_TYPE = "application/vnd.mf-rag.docling-parse+json;version=1"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MESSAGES = {
    "CHECKSUM_MISMATCH": "X-Content-Sha256 does not match the request body",
    "UPLOAD_TOO_LARGE": "request body exceeds the upload limit",
    "UNSUPPORTED_MEDIA_TYPE": "request body must be a PDF sent as application/pdf",
    "PDF_PAGE_LIMIT_EXCEEDED": "PDF exceeds the page limit",
    "DOCLING_CONVERSION_FAILED": "Docling could not convert the PDF",
    "DOCLING_PARTIAL_CONVERSION": "Docling converted the PDF only partially",
    "EMPTY_PARSED_CONTENT": "the PDF produced no content",
    "NOT_FOUND": "not found",
    "METHOD_NOT_ALLOWED": "method not allowed",
    "BAD_REQUEST": "bad request",
    "INTERNAL_ERROR": "internal error",
    "DOCLING_BUSY": "the Docling service is at capacity",
    "CLIENT_CLOSED_REQUEST": "client closed the request before conversion",
}
_HTTP_CODES = {400: "BAD_REQUEST", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "UPLOAD_TOO_LARGE"}

log = logging.getLogger(__name__)

# How often a queued parse checks whether its client is still connected.
QUEUE_POLL_S = 2.0


def client_disconnected(environ: dict) -> bool:
    """True when the peer has closed the connection (readable EOF on the gunicorn socket).

    Unread bytes or a missing socket (tests, other servers) count as connected.
    """
    sock = environ.get("gunicorn.socket")
    if sock is None:
        return False
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        return bool(readable) and sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


class ConversionGate:
    """One conversion at a time per process; /health reads the state without waiting.

    `capacity` bounds parses admitted at once (converting + queued) so that one
    gunicorn thread always stays free for /health.
    """

    def __init__(self, capacity: int):
        self._capacity = capacity
        self._conversion = threading.Lock()
        self._state = threading.Lock()
        self._admitted = 0
        self._active_since: float | None = None

    def admit(self) -> bool:
        with self._state:
            if self._admitted >= self._capacity:
                return False
            self._admitted += 1
            return True

    def leave(self) -> None:
        with self._state:
            self._admitted -= 1

    def acquire(self, gone: Callable[[], bool]) -> bool:
        """Waits for the conversion slot; False if the client left while waiting."""
        while not self._conversion.acquire(timeout=QUEUE_POLL_S):
            if gone():
                return False
        if gone():
            self._conversion.release()
            return False
        with self._state:
            self._active_since = time.monotonic()
        return True

    def release(self) -> None:
        with self._state:
            self._active_since = None
        self._conversion.release()

    def snapshot(self) -> dict:
        with self._state:
            active_since, admitted = self._active_since, self._admitted
        busy = active_since is not None
        return {
            "busy": busy,
            "activeForMs": round((time.monotonic() - active_since) * 1000) if busy else None,
            "queuedRequests": admitted - (1 if busy else 0),
        }


def _error(status: int, code: str) -> Response:
    response = jsonify({"code": code, "message": _MESSAGES[code]})
    response.status_code = status
    return response


def create_app(
    convert: Callable[[bytes], DoclingDocument] | None = None,
    chunker=None,
    settings: converter.Settings | None = None,
) -> Flask:
    settings = settings or converter.Settings.from_env()
    if convert is None:
        docling = converter.get_converter(settings)
        convert = lambda pdf: converter.convert_pdf(docling, pdf)  # noqa: E731
    if chunker is None:
        chunker = build_chunker(settings.tokenizer_dir, converter.CHUNK_MAX_TOKENS, converter.CHUNK_MERGE_PEERS)
    producer = converter.producer()
    gate = ConversionGate(capacity=max(1, settings.http_threads - 1))

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = settings.max_upload_bytes

    @app.get("/health")
    def health():
        return jsonify({
            "status": "ok",
            "parserVersion": producer["parserVersion"],
            "serviceVersion": producer["serviceVersion"],
            "doclingVersion": producer["doclingVersion"],
            "normalizerVersion": producer["normalizerVersion"],
            "pipelineOptionsSha256": producer["pipelineOptionsSha256"],
            "modelsLoaded": True,
            **gate.snapshot(),
        })

    @app.post("/v1/parse")
    def parse():
        if request.mimetype != "application/pdf":
            return _error(415, "UNSUPPORTED_MEDIA_TYPE")
        body = request.get_data(cache=False)
        if not body.startswith(b"%PDF-"):
            return _error(415, "UNSUPPORTED_MEDIA_TYPE")
        sha256 = hashlib.sha256(body).hexdigest()
        expected = request.headers.get("X-Content-Sha256", "").strip().lower()
        if not _SHA256.match(expected) or expected != sha256:
            return _error(400, "CHECKSUM_MISMATCH")
        try:
            if converter.count_pages(body) > settings.max_pages:
                return _error(422, "PDF_PAGE_LIMIT_EXCEEDED")
        except converter.ConversionError as error:
            return _error(422, error.code)
        if not gate.admit():
            log.warning("parse rejected: conversion queue full")
            return _error(503, "DOCLING_BUSY")
        try:
            environ = request.environ
            if not gate.acquire(lambda: client_disconnected(environ)):
                log.info("parse dropped: client disconnected while queued")
                return _error(499, "CLIENT_CLOSED_REQUEST")
            try:
                started = time.perf_counter()
                document = convert(body)
                conversion_ms = round((time.perf_counter() - started) * 1000)
                wire = normalize_document(
                    document,
                    chunker,
                    producer=producer,
                    source_sha256=sha256,
                    byte_size=len(body),
                    conversion_ms=conversion_ms,
                    header_sizes=header_font_sizes(document, body),
                )
            finally:
                gate.release()
        except converter.ConversionError as error:
            return _error(422, error.code)
        except EmptyParsedContent:
            return _error(422, "EMPTY_PARSED_CONTENT")
        finally:
            gate.leave()
        log.info("parsed pdf pages=%d chunks=%d conversion_ms=%d", wire["pageCount"], len(wire["chunks"]), conversion_ms)
        return Response(json.dumps(wire, ensure_ascii=False), status=200, content_type=DOCLING_PARSE_MEDIA_TYPE)

    @app.errorhandler(HTTPException)
    def http_error(error: HTTPException):
        return _error(error.code or 500, _HTTP_CODES.get(error.code or 500, "INTERNAL_ERROR"))

    @app.errorhandler(Exception)
    def unexpected(error: Exception):
        log.exception("unexpected error in %s", request.path)
        return _error(500, "INTERNAL_ERROR")

    return app
