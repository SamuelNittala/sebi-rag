"""Category lists beside a left label column.

Passive p9 (`Our Passive Fund Offerings`): Docling reads six left-column section headers
(`Domestic broad based offerings` ... `Debt offerings`) followed by ONE list holding every
fund of the right column, so HybridChunker heads all 59 items with the last header and drops
the page title (all headers share one level). Geometry says which items belong to which label:

- a run of consecutive section headers on one page, directly followed in reading order by list
  items / text; the run's trailing headers whose vertical centre is not above the first item are
  the label column (>= 2 of them), and the items taken are those lying entirely right of it;
- the list's items are split where the top-to-top pitch exceeds GAP_FACTOR x the median pitch;
- there must be exactly one group per header, and each header's vertical centre must fall
  inside its group's vertical extent (top of first item to bottom of last), in order.

Anything else is left to HybridChunker. Each group is headed by the page title (the run's last
header above the list, else the nearest section header/title before the run on the same page,
if any) and its category.
"""

from __future__ import annotations

from dataclasses import dataclass
from statistics import median

from docling_core.types.doc import DocItemLabel, DoclingDocument, TextItem

GAP_FACTOR = 1.5
_HEADERS = {DocItemLabel.SECTION_HEADER}
_TITLES = {DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE}
_BODY = {DocItemLabel.LIST_ITEM, DocItemLabel.TEXT}


@dataclass(frozen=True)
class CategoryGroup:
    title: str | None
    category: str
    items: list[TextItem]


def category_groups(doc: DoclingDocument) -> list[CategoryGroup]:
    body = [item for item, _ in doc.iterate_items(with_groups=False) if getattr(item, "prov", None)]
    groups: list[CategoryGroup] = []
    index = 0
    while index < len(body):
        run = _header_run(body, index)
        if len(run) < 2:
            index += max(1, len(run))
            continue
        end = index + len(run)
        candidates = _following_body(body, end, run[0].prov[0].page_no)
        labels = _label_column(run, candidates, doc)
        items = _right_of(candidates, labels, doc)
        found = _assign(labels, items, doc) if len(labels) >= 2 else []
        if found:
            leading = run[: len(run) - len(labels)]
            title = leading[-1].text.strip() if leading else _page_title(body, index, run[0].prov[0].page_no)
            groups += [CategoryGroup(title, header.text.strip(), group) for header, group in found]
        index = end + len(items)
    return groups


def _header_run(body: list, start: int) -> list[TextItem]:
    run: list[TextItem] = []
    for item in body[start:]:
        if not (isinstance(item, TextItem) and item.label in _HEADERS and item.text.strip()):
            break
        if run and item.prov[0].page_no != run[0].prov[0].page_no:
            break
        run.append(item)
    return run


def _box(item, doc: DoclingDocument):
    prov = item.prov[0]
    return prov.bbox.to_top_left_origin(page_height=doc.pages[prov.page_no].size.height)


def _centre(item, doc: DoclingDocument) -> float:
    box = _box(item, doc)
    return (box.t + box.b) / 2


def _following_body(body: list, start: int, page: int) -> list[TextItem]:
    items: list[TextItem] = []
    for item in body[start:]:
        if not (isinstance(item, TextItem) and item.label in _BODY and item.text.strip()) or item.prov[0].page_no != page:
            break
        items.append(item)
    return items


def _label_column(run: list[TextItem], candidates: list[TextItem], doc: DoclingDocument) -> list[TextItem]:
    """The run's trailing headers that sit beside the list (centre not above its first item);
    headers above it (the page title) are not labels."""
    if not candidates:
        return []
    top = _box(candidates[0], doc).t
    labels: list[TextItem] = []
    for header in reversed(run):
        if _centre(header, doc) < top:
            break
        labels.insert(0, header)
    return labels


def _right_of(candidates: list[TextItem], labels: list[TextItem], doc: DoclingDocument) -> list[TextItem]:
    """Leading candidates lying entirely right of every label."""
    if not labels:
        return []
    column = max(_box(h, doc).r for h in labels)
    items: list[TextItem] = []
    for item in candidates:
        if _box(item, doc).l < column:
            break
        items.append(item)
    return items


def _assign(run: list[TextItem], items: list[TextItem], doc: DoclingDocument) -> list[tuple[TextItem, list[TextItem]]]:
    if len(items) < len(run):
        return []
    boxes = [_box(i, doc) for i in items]
    pitches = [b.t - a.t for a, b in zip(boxes, boxes[1:])]
    if any(p <= 0 for p in pitches):
        return []  # not one top-to-bottom column
    threshold = GAP_FACTOR * median(pitches)
    groups: list[list[int]] = [[0]]
    for i, pitch in enumerate(pitches, start=1):
        if pitch > threshold:
            groups.append([])
        groups[-1].append(i)
    if len(groups) != len(run):
        return []
    out = []
    for header, group in zip(run, groups):
        header_box = _box(header, doc)
        centre = (header_box.t + header_box.b) / 2
        if not boxes[group[0]].t <= centre <= boxes[group[-1]].b:
            return []
        out.append((header, [items[i] for i in group]))
    return out


def _page_title(body: list, start: int, page: int) -> str | None:
    for item in reversed(body[:start]):
        if item.prov[0].page_no != page:
            return None
        if isinstance(item, TextItem) and item.label in _TITLES and item.text.strip():
            return item.text.strip()
    return None
