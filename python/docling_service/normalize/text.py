"""Text repairs: superscript ordinal join and label/value line join."""

from __future__ import annotations

import re

from docling_core.types.doc import DoclingDocument

_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
_ORDINAL = re.compile(rf"\b(\d{{1,2}})\s+(st|nd|rd|th)\b(?=\s+{_MONTH}\b)")
VALUE_ONLY = re.compile(r"^[-+]?[₹$]?\s?[\d.,]+\s?(%|Cr\.?|Lakh|years?)?$")
_DATE = (
    rf"(?:\d{{1,2}}\s?(?:st|nd|rd|th)?\s+{_MONTH}\.?,?\s+\d{{4}}"  # 31st August, 2026
    rf"|{_MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"  # Aug 31, 2026
    rf"|{_MONTH}\.?,?\s+\d{{4}}"  # August 2026
    r"|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})"  # 31/08/2026
)
# `Data as on 31st August, 2026`: a dated as-of phrase that scopes the whole page.
_AS_OF = re.compile(rf"\bas\s+(?:on|of|at)\s+{_DATE}\b", re.IGNORECASE)


def join_ordinals(text: str) -> tuple[str, bool]:
    """`31 st August` -> `31st August` (superscript ordinals split by PDF text extraction)."""
    joined = _ORDINAL.sub(r"\1\2", text)
    return joined, joined != text


def is_as_of_note(text: str) -> bool:
    """True for text carrying a dated as-of phrase (`Data as on 31st August, 2026`)."""
    return _AS_OF.search(text) is not None


_PAGE_NUMBER = re.compile(r"^(?:page\s*)?\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?$", re.IGNORECASE)
# Page furniture that is never answerable content, even on a single page: the AMC's legal
# name line, the document title band and the past-performance disclaimer.
_BOILERPLATE = (
    re.compile(r"^[A-Z0-9&().,'\- ]+\b(?:PRIVATE\s+)?(?:LIMITED|LTD\.?)$"),
    re.compile(r"^(?:[A-Z]+\s+){0,3}FACTSHEET$"),
    re.compile(r"^past performance (?:is not|may or may not)\b.*$", re.IGNORECASE),
)


def is_page_number(text: str) -> bool:
    """`34`, `Page 3`, `3 of 10`, `3/10`."""
    return _PAGE_NUMBER.match(" ".join(text.split())) is not None


def is_page_boilerplate(text: str) -> bool:
    line = " ".join(text.split())
    return any(p.match(line) for p in _BOILERPLATE)


def running_key(text: str) -> str:
    """Repetition key for page furniture: case, spacing and digits normalized
    (`34 MIRAE ASSET NIFTY 50 ETF` and `35 MIRAE ASSET NIFTY 100 ETF` share one)."""
    return re.sub(r"\d+", "#", " ".join(text.lower().split()))


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
