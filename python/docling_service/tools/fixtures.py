"""Fixture regeneration.

  python -m docling_service.tools.fixtures convert <file.pdf>          # needs models; writes <stem>.docling.json
  python -m docling_service.tools.fixtures normalize <file.docling.json> # tokenizer only; writes <stem>.wire.json

`normalize` reads the sibling <stem>.pdf for source sha256/byteSize and writes
conversionMs = 0 so the golden is deterministic.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from docling_core.types.doc import DoclingDocument, ImageRefMode

from docling_service import converter
from docling_service.normalize.chunks import build_chunker, normalize_document


def default_chunker():
    settings = converter.Settings.from_env()
    return build_chunker(settings.tokenizer_dir, converter.CHUNK_MAX_TOKENS, converter.CHUNK_MERGE_PEERS)


def wire_for(docling_json: Path, chunker) -> dict:
    stem = docling_json.name.removesuffix(".docling.json")
    pdf = (docling_json.parent / f"{stem}.pdf").read_bytes()
    doc = DoclingDocument.load_from_json(docling_json)
    return normalize_document(
        doc,
        chunker,
        producer=converter.producer(),
        source_sha256=hashlib.sha256(pdf).hexdigest(),
        byte_size=len(pdf),
        conversion_ms=0,
    )


def dump_wire(wire: dict) -> str:
    return json.dumps(wire, indent=2, ensure_ascii=False) + "\n"


def wire_path(docling_json: Path) -> Path:
    return docling_json.parent / (docling_json.name.removesuffix(".docling.json") + ".wire.json")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in {"convert", "normalize"}:
        print(__doc__, file=sys.stderr)
        return 2
    command, path = argv[0], Path(argv[1])
    if command == "convert":
        result = converter.get_converter(converter.Settings.from_env()).convert(path)
        out = path.with_suffix(".docling.json")
        result.document.save_as_json(out, image_mode=ImageRefMode.PLACEHOLDER)
    else:
        out = wire_path(path)
        out.write_text(dump_wire(wire_for(path, default_chunker())), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
