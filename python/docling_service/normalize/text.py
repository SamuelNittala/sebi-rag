"""Text repairs: superscript ordinal join and label/value line join."""

from __future__ import annotations

import re

from docling_core.types.doc import DoclingDocument

_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
_ORDINAL = re.compile(rf"\b(\d{{1,2}})\s+(st|nd|rd|th)\b(?=\s+{_MONTH}\b)")
VALUE_ONLY = re.compile(r"^[-+]?[₹$]?\s?[\d.,]+\s?(%|Cr\.?|Lakh|years?)?$")


def join_ordinals(text: str) -> tuple[str, bool]:
    """`31 st August` -> `31st August` (superscript ordinals split by PDF text extraction)."""
    joined = _ORDINAL.sub(r"\1\2", text)
    return joined, joined != text


def is_value_only(line: str) -> bool:
    return any(ch.isdigit() for ch in line) and VALUE_ONLY.match(line.strip()) is not None


def join_label_value_lines(text: str) -> tuple[str, bool]:
    """Join a line ending in `:` with a following value-only line."""
    lines = text.split("\n")
    out: list[str] = []
    changed = False
    for line in lines:
        if out and out[-1].rstrip().endswith(":") and is_value_only(line):
            out[-1] = f"{out[-1].rstrip()} {line.strip()}"
            changed = True
        else:
            out.append(line)
    return "\n".join(out), changed


def repair_document_ordinals(doc: DoclingDocument) -> set[str]:
    """Join ordinals in every text item and table cell in place; returns refs of changed items."""
    changed: set[str] = set()
    for item in doc.texts:
        joined, did = join_ordinals(item.text)
        if did:
            item.text = joined
            changed.add(item.self_ref)
    for table in doc.tables:
        for cell in table.data.table_cells:
            joined, did = join_ordinals(cell.text)
            if did:
                cell.text = joined
                changed.add(table.self_ref)
    return changed
