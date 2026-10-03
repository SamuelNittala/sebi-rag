"""Pinned, VLM-free Docling converter and the version identity derived from it.

Output-affecting options are code constants and hashed into
pipelineOptionsSha256; only speed/runtime settings come from the environment.
"""

from __future__ import annotations

import hashlib
import json
import os
from io import BytesIO
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from importlib.metadata import version

from docling.datamodel.accelerator_options import AcceleratorOptions
from docling.datamodel.base_models import ConversionStatus, DocumentStream, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import DoclingDocument

from docling_service import SERVICE_VERSION
from docling_service.normalize import NORMALIZER_VERSION

CHUNK_MAX_TOKENS = 450
CHUNK_MERGE_PEERS = True
TOKENIZER_MODEL_ID = "BAAI/bge-m3"
TOKENIZER_DIRNAME = "bge-m3-tokenizer"

# Runtime-only option keys: they change speed or model location, not output.
_RUNTIME_OPTION_KEYS = (
    "document_timeout",
    "accelerator_options",
    "artifacts_path",
    "ocr_batch_size",
    "layout_batch_size",
    "table_batch_size",
    "batch_polling_interval_seconds",
    "queue_max_size",
    "stage_shutdown_timeout_seconds",
)


@dataclass(frozen=True)
class Settings:
    models_dir: str = "/opt/docling-models"
    num_threads: int = 4
    document_timeout_s: float = 1700.0
    max_upload_bytes: int = 26_214_400
    max_pages: int = 500
    # gunicorn gthread pool size (the CMD passes the same variable to --threads).
    # One thread stays free for /health; the rest may hold or wait for a parse.
    http_threads: int = 12

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            models_dir=os.environ.get("DOCLING_MODELS_DIR", "/opt/docling-models"),
            num_threads=int(os.environ.get("DOCLING_NUM_THREADS", "4")),
            document_timeout_s=float(os.environ.get("DOCLING_DOCUMENT_TIMEOUT_S", "1700")),
            max_upload_bytes=int(os.environ.get("DOCLING_MAX_UPLOAD_BYTES", "26214400")),
            max_pages=int(os.environ.get("DOCLING_MAX_PAGES", "500")),
            http_threads=int(os.environ.get("DOCLING_HTTP_THREADS", "12")),
        )

    @property
    def tokenizer_dir(self) -> str:
        return os.path.join(self.models_dir, TOKENIZER_DIRNAME)


def build_pipeline_options(settings: Settings | None = None) -> PdfPipelineOptions:
    settings = settings or Settings()
    opts = PdfPipelineOptions()
    # Docling defaults: do_ocr=True, do_picture_classification=False. Set every
    # output-affecting option explicitly.
    opts.do_ocr = False
    opts.do_table_structure = True
    opts.table_structure_options.mode = TableFormerMode.ACCURATE
    opts.table_structure_options.do_cell_matching = True
    opts.do_picture_classification = True
    opts.do_picture_description = False
    opts.do_chart_extraction = False
    opts.do_formula_enrichment = False
    opts.do_code_enrichment = False
    opts.enable_remote_services = False
    opts.allow_external_plugins = False
    opts.generate_page_images = False
    opts.generate_picture_images = False
    opts.generate_table_images = False
    opts.artifacts_path = settings.models_dir
    opts.document_timeout = settings.document_timeout_s
    opts.accelerator_options = AcceleratorOptions(device="cpu", num_threads=settings.num_threads)
    return opts


def pipeline_options_sha256(opts: PdfPipelineOptions, chunk_max_tokens: int = CHUNK_MAX_TOKENS) -> str:
    # serialize_as_any: plain model_dump() serializes table_structure_options as {}.
    # Python mode keeps sets as sets so they can be sorted (JSON mode lists them in
    # hash order, which changes with PYTHONHASHSEED).
    dumped = _canonical(opts.model_dump(mode="python", serialize_as_any=True))
    canonical = {k: v for k, v in dumped.items() if k not in _RUNTIME_OPTION_KEYS}
    canonical["device"] = str(opts.accelerator_options.device)
    canonical["chunker"] = {
        "kind": "hybrid",
        "max_tokens": chunk_max_tokens,
        "merge_peers": CHUNK_MERGE_PEERS,
        "tokenizer": TOKENIZER_MODEL_ID,
    }
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _canonical(value):
    if isinstance(value, dict):
        return {str(k): _canonical(v) for k, v in value.items()}
    if isinstance(value, (set, frozenset)):
        return sorted((_canonical(v) for v in value), key=lambda v: json.dumps(v, sort_keys=True))
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    if isinstance(value, Enum):
        return _canonical(value.value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def parser_version() -> str:
    sha = pipeline_options_sha256(build_pipeline_options())
    return f"docling-{version('docling')}+norm-{NORMALIZER_VERSION}+opts-{sha[:12]}"


def producer() -> dict:
    return {
        "parserVersion": parser_version(),
        "serviceVersion": SERVICE_VERSION,
        "doclingVersion": version("docling"),
        "doclingCoreVersion": version("docling-core"),
        "doclingIbmModelsVersion": version("docling-ibm-models"),
        "normalizerVersion": NORMALIZER_VERSION,
        "pipelineOptionsSha256": pipeline_options_sha256(build_pipeline_options()),
    }


@lru_cache(maxsize=1)
def get_converter(settings: Settings) -> DocumentConverter:
    """Single converter per process; models load here, once."""
    opts = build_pipeline_options(settings)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)})
    converter.initialize_pipeline(InputFormat.PDF)
    return converter


class ConversionError(Exception):
    """Deterministic conversion failure; `code` is the 422 error code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def count_pages(pdf: bytes) -> int:
    import pypdfium2
    # PDFium is not thread-safe; Docling serializes its own PDFium calls on this lock,
    # and a queued request counts pages while another request converts.
    from docling.utils.locks import pypdfium2_lock

    with pypdfium2_lock:
        try:
            document = pypdfium2.PdfDocument(pdf)
        except pypdfium2.PdfiumError as error:
            raise ConversionError("DOCLING_CONVERSION_FAILED") from error
        try:
            return len(document)
        finally:
            document.close()


def convert_pdf(converter: DocumentConverter, pdf: bytes) -> DoclingDocument:
    try:
        result = converter.convert(DocumentStream(name="input.pdf", stream=BytesIO(pdf)), raises_on_error=False)
    except Exception as error:  # docling raises for unreadable input despite raises_on_error=False
        raise ConversionError("DOCLING_CONVERSION_FAILED") from error
    if result.status == ConversionStatus.SUCCESS:
        return result.document
    if result.status == ConversionStatus.PARTIAL_SUCCESS:
        raise ConversionError("DOCLING_PARTIAL_CONVERSION")
    raise ConversionError("DOCLING_CONVERSION_FAILED")
