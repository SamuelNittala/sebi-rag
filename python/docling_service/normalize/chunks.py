"""Chunk assembly: repaired DoclingDocument -> wire response (contract v1).

HybridChunker decides text chunk boundaries and headings. Its output is then split
so no chunk mixes kinds: text runs stay text (re-serialized per item, as Docling does
when it splits), tables are replaced by our table serialization, pictures by the
picture normalizer. Items HybridChunker skips (table captions/footnotes) become a
text chunk after their table. Everything is ordered by body reading order.

Page headers/footers (Docling `page_header`/`page_footer`) are kept by default: scheme
footnotes (`Pursuant to clause 14.2.2 ... performance shall not be provided.`) live there.
Dropped: page numbers, boilerplate (`text.is_page_boilerplate`: the AMC's legal name line,
`MUTUAL FUND FACTSHEET`, the past-performance disclaimer) and running lines, i.e. lines
whose digit-normalized text (`text.running_key`) recurs on several pages: short lines
(<= RUNNING_SHORT_WORDS words, no footnote marker) on >= 2 pages, longer ones on >= 3 pages
and >= RUNNING_MIN_SHARE of the document's pages, so a footnote repeated on a few scheme
pages stays. Lines with a dated as-of phrase (`Data as on 31st August, 2026`) are always
kept. A single-page conversion (fixtures, per-page requests) cannot see repetition, so it
keeps everything except page numbers and boilerplate.
Each page's kept footers become one text chunk after that page's last body item (kept
headers: one before its first), with no headings, so every chunk stays single-page and
of one kind. Page text includes them.

A dated as-of section header that HybridChunker puts in no chunk (a heading directly
followed by another heading) becomes its own text chunk.

Every chunk is held to the TS side's size measure (`budget.py`: words * 1.3 of scheme prefix +
headings + body): tables and key-value panels split between rows (`table_rows_split`, the
title heading repeated on each part), text between lines (an over-long line by words),
pictures between lines.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
from docling_core.types.doc import ContentLayer, DocItem, DocItemLabel, DoclingDocument, PictureItem, RefItem, TableItem, TextItem

from docling_service.normalize import budget
from docling_service.normalize import pictures as picture_rules
from docling_service.normalize import tables as table_rules
from docling_service.normalize import text as text_rules


_PAGE_FURNITURE = {DocItemLabel.PAGE_HEADER, DocItemLabel.PAGE_FOOTER}
RUNNING_SHORT_WORDS = 8
RUNNING_MIN_SHARE = 0.3
_FOOTNOTE_MARKER = ("*", "^", "#", "$", "@", "†")


class EmptyParsedContent(Exception):
    """The document produced no chunks."""


def build_chunker(tokenizer_dir: str, max_tokens: int, merge_peers: bool) -> HybridChunker:
    from transformers import AutoTokenizer

    tokenizer = HuggingFaceTokenizer(tokenizer=AutoTokenizer.from_pretrained(tokenizer_dir), max_tokens=max_tokens)
    return HybridChunker(tokenizer=tokenizer, merge_peers=merge_peers)


@dataclass
class _Unit:
    kind: str  # text | table | picture
    items: list[DocItem]
    headings: list[str] | None
    order: float
    text: str | None = None
    mixed: bool = False
    extra_refs: list[str] = field(default_factory=list)


def normalize_document(
    doc: DoclingDocument,
    chunker: HybridChunker,
    *,
    producer: dict,
    source_sha256: str,
    byte_size: int,
    conversion_ms: int,
) -> dict:
    changed = text_rules.repair_document_ordinals(doc)
    order = {item.self_ref: i for i, (item, _) in enumerate(doc.iterate_items(with_groups=False))}
    table_parts = {t.self_ref: table_rules.normalize_table(t) for t in doc.tables}
    picture_results = {p.self_ref: picture_rules.normalize_picture(p, doc) for p in doc.pictures}

    kept = kept_page_furniture(doc)
    units = sorted(_units_from_chunker(doc, chunker, order) + _furniture_units(doc, kept, order), key=lambda u: u.order)
    chunks = [c for unit in units for c in _wire_chunks(unit, doc, changed, table_parts, picture_results)]
    missing = _as_of_header_units(doc, order, chunks)
    if missing:
        units = sorted(units + missing, key=lambda u: u.order)
        _inherit_headings(units)
        chunks = [c for unit in units for c in _wire_chunks(unit, doc, changed, table_parts, picture_results)]
    if not chunks:
        raise EmptyParsedContent()
    for index, chunk in enumerate(chunks):
        chunk["chunkIndex"] = index

    dropped = Counter(r.dropped for r in picture_results.values() if r.dropped)
    flag_counts = Counter(flag for chunk in chunks for flag in chunk["flags"])
    page_numbers = sorted(doc.pages)
    return {
        "schemaVersion": 1,
        "producer": producer,
        "source": {"sha256": source_sha256, "byteSize": byte_size},
        "pageCount": len(page_numbers),
        "pages": _pages(doc, page_numbers, table_parts, picture_results, kept),
        "chunks": chunks,
        "diagnostics": {
            "droppedPictures": {k: dropped.get(k, 0) for k in ("logo", "signature", "stamp", "qrCode", "barCode", "noText")},
            "flagCounts": {flag: flag_counts[flag] for flag in sorted(flag_counts)},
            "conversionStatus": "success",
            "conversionMs": conversion_ms,
        },
    }


def _kind(item: DocItem) -> str:
    if isinstance(item, TableItem):
        return "table"
    if isinstance(item, PictureItem):
        return "picture"
    return "text"


def _units_from_chunker(doc: DoclingDocument, chunker: HybridChunker, order: dict[str, int]) -> list[_Unit]:
    serializer = chunker.serializer_provider.get_serializer(doc=doc)
    units: list[_Unit] = []
    seen: set[str] = set()
    for chunk in chunker.chunk(doc):
        # DocMeta holds plain DocItem copies; resolve to the typed document items.
        items = [RefItem(cref=i.self_ref).resolve(doc) for i in chunk.meta.doc_items]
        headings = list(chunk.meta.headings or [])
        runs: list[tuple[str, list[DocItem]]] = []
        for item in items:
            kind = _kind(item)
            if runs and runs[-1][0] == kind == "text":
                runs[-1][1].append(item)
            else:
                runs.append((kind, [item]))
        mixed = len(runs) > 1
        for kind, run in runs:
            if kind != "text":
                if run[0].self_ref in seen:
                    continue  # a large table HybridChunker split by plain text
                seen.add(run[0].self_ref)
                units.append(_Unit(kind, run, headings, order[run[0].self_ref], mixed=mixed))
                continue
            if mixed:
                run = [i for i in run if i.self_ref not in seen]
                if not run:
                    continue
                text = "\n".join(t for i in run if (t := serializer.serialize(item=i).text))
            else:
                text = chunk.text
            seen.update(i.self_ref for i in run)
            units.append(_Unit("text", run, headings, order[run[0].self_ref], text=text, mixed=mixed))

    covered = {i.self_ref for u in units for i in u.items}
    for item in doc.pictures + doc.tables:
        if item.self_ref not in covered and item.self_ref in order:
            units.append(_Unit(_kind(item), [item], None, order[item.self_ref]))
    for table in doc.tables:
        notes = [r.resolve(doc) for r in [*table.captions, *table.footnotes]]
        notes = [n for n in notes if isinstance(n, TextItem) and n.text.strip() and n.self_ref not in covered]
        if notes:
            text = "\n".join(n.text.strip() for n in notes)
            units.append(_Unit("text", notes, None, order.get(notes[0].self_ref, order[table.self_ref]), text=text))

    units.sort(key=lambda u: u.order)
    _inherit_headings(units)
    return units


def _inherit_headings(units: list[_Unit]) -> None:
    previous: list[str] = []
    for unit in units:
        if unit.headings is None:
            unit.headings = previous
        previous = unit.headings


def _as_of_header_units(doc: DoclingDocument, order: dict[str, int], chunks: list[dict]) -> list[_Unit]:
    """Dated as-of section headers that reach no chunk text or headings on their page (a heading
    followed directly by another heading, or heading only a dropped logo) become text units."""
    seen = {
        (page, line.strip()) for c in chunks for page in c["pages"] for line in [*c["headings"], *c["text"].split("\n")]
    }
    return [
        _Unit("text", [item], None, order[item.self_ref], text=item.text.strip())
        for item in doc.texts
        if item.label in (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE)
        and item.self_ref in order and item.prov
        and text_rules.is_as_of_note(item.text)
        and _clean_headings([item.text])
        and (item.prov[0].page_no, _clean_headings([item.text])[0]) not in seen
    ]


def kept_page_furniture(doc: DoclingDocument) -> list[TextItem]:
    """Page headers/footers worth keeping (see module doc). Document order."""
    furniture = [
        t for t in doc.texts
        if t.label in _PAGE_FURNITURE and t.content_layer == ContentLayer.FURNITURE and t.prov and t.text.strip()
    ]
    pages: dict[str, set[int]] = {}
    for t in furniture:
        pages.setdefault(text_rules.running_key(t.text), set()).add(t.prov[0].page_no)
    return [t for t in furniture if text_rules.is_as_of_note(t.text) or not _is_dropped_furniture(t.text, pages, len(doc.pages))]


def _is_dropped_furniture(text: str, pages: dict[str, set[int]], page_count: int) -> bool:
    if text_rules.is_page_number(text) or text_rules.is_page_boilerplate(text):
        return True
    count = len(pages[text_rules.running_key(text)])
    stripped = text.strip()
    if len(stripped.split()) <= RUNNING_SHORT_WORDS and not stripped.startswith(_FOOTNOTE_MARKER):
        return count >= 2
    return count >= 3 and count >= RUNNING_MIN_SHARE * page_count


def _furniture_units(doc: DoclingDocument, kept: list[TextItem], order: dict[str, int]) -> list[_Unit]:
    # Last body reading-order index on or before each page: footers go right after it,
    # headers right after the previous page's (and after that page's footers).
    last = {p: -1 for p in doc.pages}
    for item, _ in doc.iterate_items(with_groups=False):
        if getattr(item, "prov", None):
            page = item.prov[0].page_no
            last[page] = max(last.get(page, -1), order[item.self_ref])
    running, upto = -1, {}
    for page in sorted(last):
        running = max(running, last[page])
        upto[page] = running
    groups: dict[tuple[int, str], list[TextItem]] = {}
    for item in kept:
        groups.setdefault((item.prov[0].page_no, item.label), []).append(item)
    units = []
    for (page, label), items in groups.items():
        if label == DocItemLabel.PAGE_FOOTER:
            position = upto[page] + 0.5
        else:
            position = upto.get(page - 1, -1) + 0.75
        text = "\n".join(i.text.strip() for i in items)
        units.append(_Unit("text", list(items), [], position, text=text))
    return units


def _clean_headings(headings: list[str]) -> list[str]:
    return [h for h in (" ".join(h.replace("\u0000", "").split()) for h in headings) if h]


def _drop_heading_lines(text: str, headings: list[str]) -> str:
    lines = text.replace("\u0000", "").split("\n")
    return "\n".join(line for line in lines if line.strip() not in headings).strip()


def _wire_chunks(unit: _Unit, doc, changed, table_parts, picture_results) -> list[dict]:
    headings = _clean_headings(unit.headings or [])
    refs = [i.self_ref for i in unit.items]
    ordinal = ["ordinal_joined"] if changed.intersection(refs) else []
    mixed = ["mixed_chunk_split"] if unit.mixed else []

    if unit.kind == "text":
        joined, did_join = text_rules.join_label_value_lines(unit.text or "")
        body = _drop_heading_lines(joined, headings)
        flags = ordinal + (["kv_lines_joined"] if did_join else []) + mixed
        if not body:
            return []
        pieces = budget.split_body("text", headings, body, split_long_lines=True)
        return [_chunk("text", piece, headings, unit.items, doc, refs, flags) for piece in pieces]

    if unit.kind == "table":
        part = table_parts[refs[0]]
        part_headings = headings + _clean_headings([part.title] if part.title else [])
        body = _drop_heading_lines(part.text, part_headings)
        if not body:
            return []
        pieces = budget.split_body(part.kind, part_headings, body, split_long_lines=False)
        flags = ordinal + mixed + list(part.flags) + (["table_rows_split"] if len(pieces) > 1 else [])
        return [_chunk(part.kind, piece, part_headings, unit.items, doc, refs, flags) for piece in pieces]

    result = picture_results[refs[0]]
    if result.dropped:
        return []
    body = _drop_heading_lines(result.text, headings)
    if not body:
        return []
    child_ordinal = ["ordinal_joined"] if changed.intersection(result.child_refs) else []
    picture = {"classification": result.classification, "confidence": result.confidence, "pairCount": result.pair_count}
    flags = child_ordinal + list(result.flags)
    pieces = budget.split_body("picture", headings, body, split_long_lines=False)
    return [_chunk("picture", piece, headings, unit.items, doc, refs, flags, picture) for piece in pieces]


def _chunk(kind, text, headings, items, doc, refs, flags, picture=None) -> dict:
    boxes: dict[int, list[float]] = {}
    for item in items:
        for prov in item.prov:
            box = prov.bbox.to_bottom_left_origin(page_height=doc.pages[prov.page_no].size.height)
            l, r = sorted((box.l, box.r))
            b, t = sorted((box.b, box.t))
            if prov.page_no in boxes:
                cur = boxes[prov.page_no]
                boxes[prov.page_no] = [min(cur[0], l), max(cur[1], t), max(cur[2], r), min(cur[3], b)]
            else:
                boxes[prov.page_no] = [l, t, r, b]
    pages = sorted(boxes)
    return {
        "chunkIndex": -1,
        "type": kind,
        "text": text,
        "headings": headings,
        "pages": pages,
        "bboxes": [
            {"page": p, "l": round(boxes[p][0], 2), "t": round(boxes[p][1], 2), "r": round(boxes[p][2], 2), "b": round(boxes[p][3], 2)}
            for p in pages
        ],
        "itemRefs": list(dict.fromkeys(refs)),
        "flags": list(dict.fromkeys(flags)),
        "picture": picture,
    }


def _pages(doc: DoclingDocument, page_numbers: list[int], table_parts, picture_results, kept) -> list[dict]:
    lines: dict[int, list[str]] = {p: [] for p in page_numbers}
    stats = {p: Counter() for p in page_numbers}
    headers = [i for i in kept if i.label == DocItemLabel.PAGE_HEADER]
    footers = [i for i in kept if i.label == DocItemLabel.PAGE_FOOTER]
    body = [item for item, _ in doc.iterate_items(with_groups=False)]
    for item in headers + body + footers:
        if not getattr(item, "prov", None):
            continue
        page = item.prov[0].page_no
        if isinstance(item, TableItem):
            part = table_parts[item.self_ref]
            text = "\n".join(t for t in (part.title, part.text) if t)
            stats[page]["tables"] += 1
            stats[page]["bodyTextChars"] += len(text)
        elif isinstance(item, PictureItem):
            result = picture_results[item.self_ref]
            text = "" if result.dropped else result.text
            stats[page]["pictures"] += 1
            stats[page]["pictureTextChars"] += sum(len(c.text) for c in picture_rules.picture_children(item, doc))
        elif isinstance(item, TextItem):
            text = item.text.strip()
            stats[page]["textItems"] += 1
            stats[page]["bodyTextChars"] += len(text)
        else:
            continue
        if text:
            lines[page].append(text)

    out = []
    for p in page_numbers:
        size = doc.pages[p].size
        s = stats[p]
        out.append({
            "pageNumber": p,
            "width": round(size.width, 2),
            "height": round(size.height, 2),
            "text": "\n".join(lines[p]).replace("\u0000", ""),
            "hasTable": s["tables"] > 0,
            "stats": {k: s[k] for k in ("textItems", "tables", "pictures", "pictureTextChars", "bodyTextChars")},
        })
    return out
