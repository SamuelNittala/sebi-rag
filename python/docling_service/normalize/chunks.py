"""Chunk assembly: repaired DoclingDocument -> wire response (contract v1).

HybridChunker decides text chunk boundaries and headings. Its output is then split
so no chunk mixes kinds: text runs stay text (re-serialized per item, as Docling does
when it splits), tables are replaced by our table serialization, pictures by the
picture normalizer. Items HybridChunker skips (table captions/footnotes) become a
text chunk after their table. Everything is ordered by body reading order.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
from docling_core.types.doc import DocItem, DoclingDocument, PictureItem, RefItem, TableItem, TextItem

from docling_service.normalize import pictures as picture_rules
from docling_service.normalize import tables as table_rules
from docling_service.normalize import text as text_rules


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
    order: int
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

    units = _units_from_chunker(doc, chunker, order)
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
        "pages": _pages(doc, page_numbers, table_parts, picture_results),
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
    previous: list[str] = []
    for unit in units:
        if unit.headings is None:
            unit.headings = previous
        previous = unit.headings
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
        return [_chunk("text", body, headings, unit.items, doc, refs, flags)] if body else []

    if unit.kind == "table":
        out = []
        for part in table_parts[refs[0]]:
            part_headings = headings + _clean_headings([part.title] if part.title else [])
            body = _drop_heading_lines(part.text, part_headings)
            if body:
                flags = ordinal + mixed + list(part.flags)
                out.append(_chunk(part.kind, body, part_headings, unit.items, doc, refs, flags))
        return out

    result = picture_results[refs[0]]
    if result.dropped:
        return []
    body = _drop_heading_lines(result.text, headings)
    if not body:
        return []
    child_ordinal = ["ordinal_joined"] if changed.intersection(result.child_refs) else []
    picture = {"classification": result.classification, "confidence": result.confidence, "pairCount": result.pair_count}
    return [_chunk("picture", body, headings, unit.items, doc, refs, child_ordinal + list(result.flags), picture)]


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


def _pages(doc: DoclingDocument, page_numbers: list[int], table_parts, picture_results) -> list[dict]:
    lines: dict[int, list[str]] = {p: [] for p in page_numbers}
    stats = {p: Counter() for p in page_numbers}
    for item, _ in doc.iterate_items(with_groups=False):
        if not getattr(item, "prov", None):
            continue
        page = item.prov[0].page_no
        if isinstance(item, TableItem):
            parts = table_parts[item.self_ref]
            text = "\n".join(([parts[0].title] if parts and parts[0].title else []) + [p.text for p in parts if p.text])
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
