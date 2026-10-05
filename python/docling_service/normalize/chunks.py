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

Section header levels come from rendered font size (`headings.py`, when the caller passes
`header_sizes`), so a page title stays the parent of the section headers below it; headings of
earlier pages and note headers as parents are then dropped (`_drop_stale_headings`).

A dated as-of section header that HybridChunker puts in no chunk (a heading directly
followed by another heading) becomes its own text chunk.

Every chunk is held to the TS side's size measure (`budget.py`: words * 1.3 of scheme prefix +
headings + body): tables and key-value panels split between rows (`table_rows_split`, the
title heading repeated on each part), text between lines (an over-long line by words),
pictures between lines.

A list beside a left label column of category headers (passive p9 `Our Passive Fund Offerings`,
`lists.py`) yields one text chunk per category, headed [page title, category]; a category over
the budget splits between items, each part repeating both headings.

A table holding stacked sub-tables (SIP Performance pages: one Docling table per page, one
sub-table per fund) yields one chunk group per sub-table, each headed by that sub-table's title,
so a row-split continuation never carries another fund's title.

A chart legend that Docling left outside the picture's bbox (`pictures.outside_legend`) belongs to
the picture chunk: its text items join the picture chunk's itemRefs and bbox, leave their text
chunks and are not repeated in page text. An item two pictures claim goes to neither. An unbound
chart (`chart_unpaired` / `chart_multi_series_unparsed`) whose values all appear as the same
numeric tokens in the table and key-value chunks on its page is also flagged
`chart_values_in_table` (values only partly in tables are not).

A side-by-side fund table (`tables.fund_columns`, enabled by the source's fund-name prefixes) yields
one chunk group per fund column, each headed by that fund's name; a picture (riskometer) inside or
below a split table on its page whose horizontal centre lies in exactly one fund column gets that
fund's name as its last heading.

A table that yields several chunks (sub-tables, fund columns, budget row splits, key-value panels split by
budget) gives each chunk its own bbox: the union of the Docling cell bboxes behind its lines
(the first piece of a part also covers the part's title and column header rows), converted to
bottom-left-origin points and clipped to the table's bbox; where vertically stacked neighbouring
pieces overlap they meet halfway (side-by-side fund columns never do); a chunk whose cells have no bbox gets the table's. A table in
one chunk keeps the table's bbox.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Sequence

from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer
from docling_core.types.doc import ContentLayer, DocItem, DocItemLabel, DoclingDocument, PictureItem, RefItem, TableItem, TextItem

from docling_service.normalize import budget
from docling_service.normalize.chart_graphics import ChartGraphics
from docling_service.normalize import headings as heading_rules
from docling_service.normalize import lists as list_rules
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
    page_scoped: bool = False  # inherits headings only from a unit on its own page


def normalize_document(
    doc: DoclingDocument,
    chunker: HybridChunker,
    *,
    producer: dict,
    source_sha256: str,
    byte_size: int,
    conversion_ms: int,
    header_sizes: dict[str, float] | None = None,
    chart_graphics: dict[str, ChartGraphics] | None = None,
    fund_name_prefixes: Sequence[str] = (),
) -> dict:
    """`header_sizes` (self_ref -> rendered pt, `headings.header_font_sizes`) sets section header
    levels before chunking; None keeps Docling's (all level 1). `chart_graphics` (picture self_ref
    -> `chart_graphics.picture_graphics`) enables chart title lines and colour pairing.
    `fund_name_prefixes` (the source's, e.g. `Mirae Asset`) enables the side-by-side fund table
    split (`tables.fund_columns`); empty keeps every table whole."""
    leveled = heading_rules.assign_header_levels(doc, header_sizes) if header_sizes else False
    changed = text_rules.repair_document_ordinals(doc)
    order = {item.self_ref: i for i, (item, _) in enumerate(doc.iterate_items(with_groups=False))}
    fund_columns = table_rules.fund_columns(doc, fund_name_prefixes)
    table_parts = {t.self_ref: table_rules.normalize_table(t, fund_columns.get(t.self_ref)) for t in doc.tables}
    picture_funds = _picture_funds(doc, fund_columns)
    graphics = chart_graphics or {}
    legends = _outside_legends(doc, graphics)
    picture_results = {
        p.self_ref: picture_rules.normalize_picture(p, doc, graphics.get(p.self_ref), legends[p.self_ref]) for p in doc.pictures
    }
    claims = {ref: legends[ref] for ref, r in picture_results.items() if r.legend_refs and not r.dropped}

    kept = kept_page_furniture(doc)
    units = sorted(
        _units_from_chunker(doc, chunker, order, leveled, claims) + _furniture_units(doc, kept, order), key=lambda u: u.order,
    )
    chunks = [c for unit in units for c in _wire_chunks(unit, doc, changed, table_parts, picture_results, picture_funds)]
    missing = _as_of_header_units(doc, order, chunks)
    if missing:
        units = sorted(units + missing, key=lambda u: u.order)
        _inherit_headings(units)
        chunks = [c for unit in units for c in _wire_chunks(unit, doc, changed, table_parts, picture_results, picture_funds)]
    if not chunks:
        raise EmptyParsedContent()
    _flag_values_in_tables(chunks, picture_results)
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
        "pages": _pages(doc, page_numbers, table_parts, picture_results, kept, {t.self_ref for v in claims.values() for t in v}),
        "chunks": chunks,
        "diagnostics": {
            "droppedPictures": {k: dropped.get(k, 0) for k in ("logo", "signature", "stamp", "qrCode", "barCode", "noText")},
            "flagCounts": {flag: flag_counts[flag] for flag in sorted(flag_counts)},
            "conversionStatus": "success",
            "conversionMs": conversion_ms,
        },
    }


def _picture_funds(doc: DoclingDocument, fund_columns: dict[str, table_rules.FundColumns]) -> dict[str, str]:
    """picture self_ref -> fund name, for pictures (riskometers) inside or below a split fund table
    on its page whose horizontal centre lies in exactly one fund column; the nearest such table
    above the picture decides."""
    tables = [(t, fund_columns[t.self_ref]) for t in doc.tables if t.self_ref in fund_columns and len(t.prov) == 1]
    out: dict[str, str] = {}
    for picture in doc.pictures:
        if len(picture.prov) != 1:
            continue
        prov = picture.prov[0]
        height = doc.pages[prov.page_no].size.height
        box = prov.bbox.to_top_left_origin(page_height=height)
        centre = (box.l + box.r) / 2
        above = [
            (table_box.t, columns)
            for table, columns in tables
            if table.prov[0].page_no == prov.page_no
            and (table_box := table.prov[0].bbox.to_top_left_origin(page_height=height)).t <= box.t
        ]
        if not above:
            continue
        columns = max(above, key=lambda a: a[0])[1]
        hits = [name for col, name in columns.names.items() if col in columns.spans and columns.spans[col][0] <= centre <= columns.spans[col][1]]
        if len(hits) == 1:
            out[picture.self_ref] = hits[0]
    return out


def _outside_legends(doc: DoclingDocument, graphics: dict[str, ChartGraphics]) -> dict[str, list[TextItem]]:
    """picture self_ref -> its outside legend items; a picture sharing an item with another gets none."""
    legends = {p.self_ref: picture_rules.outside_legend(p, doc, graphics.get(p.self_ref)) for p in doc.pictures}
    counts = Counter(t.self_ref for items in legends.values() for t in items)
    return {ref: [] if any(counts[t.self_ref] > 1 for t in items) else items for ref, items in legends.items()}


def _flag_values_in_tables(chunks: list[dict], picture_results) -> None:
    """Adds `chart_values_in_table` to unbound chart chunks whose values all appear in a table or
    key-value chunk on the chart's page."""
    tables: dict[int, list[str]] = {}
    for chunk in chunks:
        if chunk["type"] in ("table", "key_value"):
            for page in chunk["pages"]:
                tables.setdefault(page, []).append(chunk["text"])
    for chunk in chunks:
        if chunk["type"] != "picture" or not {"chart_unpaired", "chart_multi_series_unparsed"} & set(chunk["flags"]):
            continue
        texts = [t for page in chunk["pages"] for t in tables.get(page, [])]
        if picture_rules.values_in_texts(picture_results[chunk["itemRefs"][0]].values, texts):
            chunk["flags"].append("chart_values_in_table")


def _kind(item: DocItem) -> str:
    if isinstance(item, TableItem):
        return "table"
    if isinstance(item, PictureItem):
        return "picture"
    return "text"


def _units_from_chunker(
    doc: DoclingDocument, chunker: HybridChunker, order: dict[str, int], leveled: bool = False,
    legends: dict[str, list[TextItem]] | None = None,
) -> list[_Unit]:
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
    if leveled:
        _drop_stale_headings(units, doc)
    units = _regroup_category_lists(units, doc, order, serializer)
    _restore_page_title_headings(units, doc)

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
    if legends:
        units = _claim_legends(units, legends, order, serializer)

    units.sort(key=lambda u: u.order)
    _inherit_headings(units)
    return units


def _claim_legends(units: list[_Unit], legends: dict[str, list[TextItem]], order: dict[str, int], serializer) -> list[_Unit]:
    """Outside legend items leave their text units (re-serialized per item, a unit left empty is
    dropped) and join their picture's unit."""
    claimed = {t.self_ref for items in legends.values() for t in items}
    out: list[_Unit] = []
    for unit in units:
        if unit.kind == "text" and any(i.self_ref in claimed for i in unit.items):
            kept = [i for i in unit.items if i.self_ref not in claimed]
            if kept:
                text = "\n".join(t for i in kept if (t := serializer.serialize(item=i).text))
                out.append(_Unit("text", kept, unit.headings, order[kept[0].self_ref], text=text, mixed=unit.mixed))
            continue
        if unit.kind == "picture" and unit.items[0].self_ref in legends:
            unit.items = unit.items + legends[unit.items[0].self_ref]
        out.append(unit)
    return out


def _regroup_category_lists(units: list[_Unit], doc: DoclingDocument, order: dict[str, int], serializer) -> list[_Unit]:
    """Items of a list beside a label column (`lists.category_groups`) leave HybridChunker's text
    units and become one text unit per category, headed [page title, category]; `_wire_chunks`
    splits an over-budget category between items, repeating those headings."""
    groups = list_rules.category_groups(doc)
    if not groups:
        return units
    moved = {i.self_ref for g in groups for i in g.items}

    def serialized(items: list[DocItem]) -> str:
        return "\n".join(t for i in items if (t := serializer.serialize(item=i).text))

    out: list[_Unit] = []
    for unit in units:
        kept = [i for i in unit.items if i.self_ref not in moved]
        if len(kept) == len(unit.items):
            out.append(unit)
        elif kept:
            out.append(_Unit(unit.kind, kept, unit.headings, order[kept[0].self_ref], text=serialized(kept), mixed=unit.mixed))
    for group in groups:
        headings = [h for h in (group.title, group.category) if h]
        out.append(_Unit("text", list(group.items), headings, order[group.items[0].self_ref], text=serialized(group.items)))
    return out


def _drop_stale_headings(units: list[_Unit], doc: DoclingDocument) -> None:
    """With nested levels HierarchicalChunker keeps a larger header until one of its size or larger
    follows, across pages (a glossary title would head every later page). A unit keeps the headings
    that are headers on its own page (or no header's text at all); a unit on a page whose headers
    it has not reached yet (a continuation) keeps only its last heading, as before levels (a cover
    page's large lines are no hierarchy: the cover's fund name would head the index pages).
    Note headers (`headings.is_note`: a dated as-of line, the past-performance disclaimer) stay only
    as the last heading (content directly below them), never as a parent; an as-of header that
    heads nothing becomes its own text chunk (`_as_of_header_units`), as before levels."""
    header_pages: dict[str, set[int]] = {}
    for item, _ in doc.iterate_items(with_groups=False):
        if isinstance(item, TextItem) and item.label in (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE) and item.prov:
            for text in _clean_headings([item.text]):
                header_pages.setdefault(text, set()).add(item.prov[0].page_no)
    for unit in units:
        if not unit.headings or not unit.items or not unit.items[0].prov:
            continue
        page = unit.items[0].prov[0].page_no
        cleaned = [_clean_headings([h]) for h in unit.headings]
        own = [h for h, c in zip(unit.headings, cleaned) if not c or page in header_pages.get(c[0], {page})]
        kept = own or unit.headings[-1:]
        unit.headings = [h for i, h in enumerate(kept) if i == len(kept) - 1 or not heading_rules.is_note(h)]


def _restore_page_title_headings(units: list[_Unit], doc: DoclingDocument) -> None:
    """A page that opens with exactly two consecutive section headers (`MIRAE ASSET NIFTY 50 ETF`
    then `NSE Symbol: ...`; `MIRAE ASSET LONG TERM FUND 1` then `(Erstwhile known as ...)`)
    loses the first from HybridChunker's headings (same level). Units on that page headed by
    the second alone get the first back as parent heading. A dated as-of header ends the run
    (`_as_of_header_units` handles those); longer runs (side-by-side scheme headers on Asset
    Allocation pages, label columns) are left alone."""
    leading: dict[int, list[str]] = {}
    started: set[int] = set()
    for item, _ in doc.iterate_items(with_groups=False):
        if not getattr(item, "prov", None):
            continue
        page = item.prov[0].page_no
        if page in started:
            continue
        if isinstance(item, PictureItem) and page not in leading:
            continue  # a logo above the title
        if (
            isinstance(item, TextItem) and item.label in (DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE)
            and _clean_headings([item.text]) and not text_rules.is_as_of_note(item.text)
        ):
            leading.setdefault(page, []).append(_clean_headings([item.text])[0])
            continue
        started.add(page)
    for unit in units:
        if not unit.items or not unit.items[0].prov:
            continue
        run = leading.get(unit.items[0].prov[0].page_no, [])
        if len(run) == 2 and run[0] != run[1] and _clean_headings(unit.headings or []) == run[1:]:
            unit.headings = run


def _inherit_headings(units: list[_Unit]) -> None:
    previous: list[str] = []
    previous_page = None
    for unit in units:
        page = unit.items[0].prov[0].page_no if unit.items and unit.items[0].prov else None
        if unit.headings is None:
            unit.headings = previous if not unit.page_scoped or page == previous_page else []
        previous, previous_page = unit.headings, page


def _as_of_header_units(doc: DoclingDocument, order: dict[str, int], chunks: list[dict]) -> list[_Unit]:
    """Dated as-of section headers that reach no chunk text or headings on their page (a heading
    followed directly by another heading, or heading only a dropped logo) become text units, headed
    like the unit before them on their page (none when they open the page: the previous page's
    headings would name its fund)."""
    seen = {
        (page, line.strip()) for c in chunks for page in c["pages"] for line in [*c["headings"], *c["text"].split("\n")]
    }
    return [
        _Unit("text", [item], None, order[item.self_ref], text=item.text.strip(), page_scoped=True)
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


def _wire_chunks(unit: _Unit, doc, changed, table_parts, picture_results, picture_funds=None) -> list[dict]:
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
        planned = []  # (kind, piece, headings, flags, source cells)
        for part in table_parts[refs[0]]:  # one per stacked sub-table, each under its own title
            part_headings = headings + _clean_headings([part.title] if part.title else [])
            body = _drop_heading_lines(part.text, part_headings)
            if not body:
                continue
            pieces = budget.split_body(part.kind, part_headings, body, split_long_lines=False)
            flags = ordinal + mixed + list(part.flags) + (["table_rows_split"] if len(pieces) > 1 else [])
            cells = _piece_cells(part, part_headings, body, pieces)
            planned += [(part.kind, piece, part_headings, flags, c) for piece, c in zip(pieces, cells)]
        table = unit.items[0]
        boxes = _meet_halfway([_cell_boxes(table, doc, cells) for *_, cells in planned]) if len(planned) > 1 else [None] * len(planned)
        return [
            _chunk(kind, piece, part_headings, unit.items, doc, refs, flags, boxes=box)
            for (kind, piece, part_headings, flags, _), box in zip(planned, boxes)
        ]

    result = picture_results[refs[0]]
    if result.dropped:
        return []
    fund = (picture_funds or {}).get(refs[0])
    if fund and (not headings or headings[-1] != fund):
        headings = [*headings, fund]
    body = _drop_heading_lines(result.text, headings)
    if not body:
        return []
    child_ordinal = ["ordinal_joined"] if changed.intersection(result.child_refs + result.legend_refs) else []
    picture = {"classification": result.classification, "confidence": result.confidence, "pairCount": result.pair_count}
    flags = child_ordinal + list(result.flags)
    pieces = budget.split_body("picture", headings, body, split_long_lines=False)
    return [_chunk("picture", piece, headings, unit.items, doc, refs, flags, picture) for piece in pieces]


def _piece_cells(part, headings: list[str], body: str, pieces: list[str]) -> list[list]:
    """The source cells of each budget piece of a table part: the cells of its lines, plus the
    part's title and header cells for the first piece. Empty lists when the lines cannot be
    lined up with the body (no cells recorded): the chunk then gets the table's bbox."""
    kept = [
        cells for line, cells in zip(part.text.replace("\u0000", "").split("\n"), part.line_cells)
        if line.strip() not in headings
    ]
    if len(part.line_cells) != len(part.text.split("\n")) or len(kept) != len(body.split("\n")):
        return [[] for _ in pieces]
    out, at = [], 0
    for index, piece in enumerate(pieces):
        count = len(piece.split("\n"))
        head = list(part.head_cells) if index == 0 else []
        out.append(head + [c for cells in kept[at : at + count] for c in cells])
        at += count
    return out


def _cell_boxes(table: TableItem, doc: DoclingDocument, cells: list) -> dict[int, list[float]] | None:
    """[l, t, r, b] (bottom-left origin) around the cells' bboxes, clipped to the table's single
    prov bbox; None (use the table's bbox) without cell bboxes or a single prov."""
    if len(table.prov) != 1:
        return None
    prov = table.prov[0]
    page_height = doc.pages[prov.page_no].size.height
    boxes = [c.bbox.to_bottom_left_origin(page_height=page_height) for c in cells if c.bbox is not None]
    if not boxes:
        return None
    outer = prov.bbox.to_bottom_left_origin(page_height=page_height)
    ol, or_ = sorted((outer.l, outer.r))
    ob, ot = sorted((outer.b, outer.t))
    l = max(ol, min(min(b.l, b.r) for b in boxes))
    r = min(or_, max(max(b.l, b.r) for b in boxes))
    b = max(ob, min(min(x.b, x.t) for x in boxes))
    t = min(ot, max(max(x.b, x.t) for x in boxes))
    if not (l < r and b < t):
        return None
    return {prov.page_no: [l, t, r, b]}


def _meet_halfway(boxes: list[dict[int, list[float]] | None]) -> list[dict[int, list[float]] | None]:
    """The pieces of one table are stacked rows: where a piece's box reaches into the next one's
    (a tall Docling cell, p104 Equity Savings' two-line benchmark cell 1.2 pt into the Focused
    title), both edges move to the middle of the overlap."""
    out = [{page: list(box) for page, box in b.items()} if b else None for b in boxes]
    for upper, lower in zip(out, out[1:]):
        if not upper or not lower:
            continue
        for page in upper.keys() & lower.keys():
            u, w = upper[page], lower[page]  # [l, t, r, b]
            beside = min(u[2], w[2]) <= max(u[0], w[0])  # fund-column parts sit side by side
            if not beside and w[1] < u[1] and w[3] < u[3] and w[1] > u[3]:
                u[3] = w[1] = (u[3] + w[1]) / 2
    return out


def _chunk(kind, text, headings, items, doc, refs, flags, picture=None, boxes=None) -> dict:
    """`boxes` (page -> [l, t, r, b]) replaces the items' bboxes (a table part's own rows)."""
    boxes = dict(boxes) if boxes else _item_boxes(items, doc)
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


def _item_boxes(items, doc) -> dict[int, list[float]]:
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
    return boxes


def _pages(doc: DoclingDocument, page_numbers: list[int], table_parts, picture_results, kept, claimed: set[str]) -> list[dict]:
    """`claimed`: outside legend items, whose text is in their picture's text."""
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
            text = "\n".join(t for part in table_parts[item.self_ref] for t in (part.title, part.text) if t)
            stats[page]["tables"] += 1
            stats[page]["bodyTextChars"] += len(text)
        elif isinstance(item, PictureItem):
            result = picture_results[item.self_ref]
            text = "" if result.dropped else result.text
            stats[page]["pictures"] += 1
            stats[page]["pictureTextChars"] += sum(len(c.text) for c in picture_rules.picture_children(item, doc))
        elif isinstance(item, TextItem):
            text = "" if item.self_ref in claimed else item.text.strip()
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
