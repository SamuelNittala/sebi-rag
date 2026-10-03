"""Section header levels from rendered font size.

Docling's PDF pipeline gives every section header level 1, and HierarchicalChunker keeps one
heading per level, so each header replaces the previous one: a page title followed directly by a
section header (`MIRAE ASSET NIFTY 500 HEALTHCARE ETF` then `Fund Information`) reaches no chunk.

Signal: the DoclingDocument keeps no font information (docling-parse's cells carry a font name
but no size, and are dropped after conversion), so sizes come from the source PDF via PDFium:
per character `FPDFText_GetFontSize` times the vertical scale of its text matrix
(sqrt|det|, which carries the CTM: the active factsheet draws in px under a 0.75 matrix, so the
raw font size alone reads 18.66 for a 14 pt title). A header's size is the most common character
size (0.1 pt) among the non-blank characters whose centre lies in its bbox, so superscripts
(`31 st`) and markers (`^`) do not count. bbox height is not used: it varies with line wrapping
and glyph extents (a wrapped 8 pt header is taller than a one-line 10 pt one).

Levels are ranked per document, so the same style gets the same level on every page: sizes
are clustered greedily from the largest (a cluster takes every size within SIZE_TOLERANCE of
its largest member, not chained), the largest cluster is level 1, the next level 2, and so on.
There is no cap: a heading path only nests headers that follow each other in reading order with
decreasing size, and capping would fold a factsheet's fund titles (fifth-largest style in the
active factsheet, below cover/index/glossary styles) into their own sections. A header without
a measured size keeps level 1 (Docling's). A document with a single size cluster is left alone.

The past-performance disclaimer, which Docling sometimes labels a section header in small print
below a fund's table (`Past Performance is not an indicator ...`), is a page note, not a
subsection of that fund: it gets level 1, so it ends the fund's heading path as it did before.
`chunks._drop_stale_headings` keeps note headers (`is_note`, also dated as-of lines) only as a
chunk's last heading.
"""

from __future__ import annotations

import ctypes
import math
from collections import Counter
from collections.abc import Iterable

from docling_core.types.doc import DocItemLabel, DoclingDocument, SectionHeaderItem

from docling_service.normalize import text as text_rules

SIZE_TOLERANCE = 0.08
_PAGE_SIZE_TOLERANCE = 0.5
_BBOX_SLACK = 1.0
_HEADER_LABELS = (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE)


def header_font_sizes(doc: DoclingDocument, pdf: bytes) -> dict[str, float]:
    """self_ref -> rendered font size (pt) of each section header/title found in `pdf`. Pages whose
    size differs from the converted page (another file, a crop box offset) give no sizes."""
    import pypdfium2
    import pypdfium2.raw as pdfium_c
    from docling.utils.locks import pypdfium2_lock

    by_page: dict[int, list] = {}
    for item in doc.texts:
        if item.label in _HEADER_LABELS and item.prov:
            by_page.setdefault(item.prov[0].page_no, []).append(item)
    if not by_page:
        return {}

    sizes: dict[str, float] = {}
    with pypdfium2_lock:  # PDFium is not thread-safe; Docling and count_pages share this lock
        document = pypdfium2.PdfDocument(pdf)
        try:
            for page_no, items in sorted(by_page.items()):
                if not 1 <= page_no <= len(document) or page_no not in doc.pages:
                    continue
                page = document[page_no - 1]
                try:
                    width, height = page.get_size()
                    expected = doc.pages[page_no].size
                    if abs(width - expected.width) > _PAGE_SIZE_TOLERANCE or abs(height - expected.height) > _PAGE_SIZE_TOLERANCE:
                        continue
                    chars = _page_chars(page, pdfium_c)
                finally:
                    page.close()
                for item in items:
                    box = item.prov[0].bbox.to_bottom_left_origin(page_height=expected.height)
                    left, right = sorted((box.l, box.r))
                    bottom, top = sorted((box.b, box.t))
                    inside = [
                        size for x, y, size in chars
                        if left - _BBOX_SLACK <= x <= right + _BBOX_SLACK and bottom - _BBOX_SLACK <= y <= top + _BBOX_SLACK
                    ]
                    if inside:
                        counts = Counter(inside)
                        sizes[item.self_ref] = max(counts, key=lambda s: (counts[s], s))
        finally:
            document.close()
    return sizes


def _page_chars(page, pdfium_c) -> list[tuple[float, float, float]]:
    """(centre x, centre y, rendered size rounded to 0.1 pt) of each non-blank character, PDF
    coordinates (bottom-left origin)."""
    text_page = page.get_textpage()
    try:
        out = []
        left, right, bottom, top = (ctypes.c_double() for _ in range(4))
        matrix = pdfium_c.FS_MATRIX()
        for index in range(pdfium_c.FPDFText_CountChars(text_page)):
            if pdfium_c.FPDFText_GetUnicode(text_page, index) <= 32:
                continue
            if not pdfium_c.FPDFText_GetCharBox(text_page, index, ctypes.byref(left), ctypes.byref(right), ctypes.byref(bottom), ctypes.byref(top)):
                continue
            if not pdfium_c.FPDFText_GetMatrix(text_page, index, ctypes.byref(matrix)):
                continue
            scale = math.sqrt(abs(matrix.a * matrix.d - matrix.b * matrix.c))
            size = round(pdfium_c.FPDFText_GetFontSize(text_page, index) * scale, 1)
            if size > 0:
                out.append(((left.value + right.value) / 2, (bottom.value + top.value) / 2, size))
        return out
    finally:
        text_page.close()


def size_levels(sizes: Iterable[float]) -> dict[float, int]:
    """Each distinct size -> its cluster's level (1 = largest)."""
    levels: dict[float, int] = {}
    anchor, level = None, 0
    for size in sorted(set(sizes), reverse=True):
        if anchor is None or size < anchor * (1 - SIZE_TOLERANCE):
            anchor, level = size, level + 1
        levels[size] = level
    return levels


def assign_header_levels(doc: DoclingDocument, sizes: dict[str, float]) -> bool:
    """Set each SectionHeaderItem's level from `sizes` (self_ref -> pt). TitleItems are always the
    top (HierarchicalChunker reads them as level 0). Returns False, changing nothing, when the
    measured sizes form fewer than two clusters."""
    headers = [t for t in doc.texts if isinstance(t, SectionHeaderItem)]
    levels = size_levels(sizes[h.self_ref] for h in headers if h.self_ref in sizes)
    if len(set(levels.values())) < 2:
        return False
    for header in headers:
        known = header.self_ref in sizes and not text_rules.is_page_boilerplate(header.text)
        header.level = levels[sizes[header.self_ref]] if known else 1
    return True


def is_note(heading: str) -> bool:
    """A header that annotates the page rather than opening a section."""
    return text_rules.is_as_of_note(heading) or text_rules.is_page_boilerplate(heading)
