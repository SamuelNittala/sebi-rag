"""HTTP boundary: GET /health, POST /v1/parse (raw PDF bytes -> wire JSON v1).

Run: gunicorn -w 1 -b 0.0.0.0:8090 --timeout 3600 'docling_service.app:create_app()'
Error bodies are {code, message} with static messages: never paths or stack traces.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Callable

from docling_core.types.doc import DoclingDocument
from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

from docling_service import converter
from docling_service.normalize.chunks import EmptyParsedContent, build_chunker, normalize_document

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
}
_HTTP_CODES = {400: "BAD_REQUEST", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 413: "UPLOAD_TOO_LARGE"}

log = logging.getLogger(__name__)


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
            )
        except converter.ConversionError as error:
            return _error(422, error.code)
        except EmptyParsedContent:
            return _error(422, "EMPTY_PARSED_CONTENT")
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
