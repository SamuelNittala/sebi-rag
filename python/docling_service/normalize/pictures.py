"""Picture normalization from picture children (vector text) and bboxes. No VLM.

- Logos, signatures, stamps, QR/bar codes are dropped by classification; pictures
  without child text are dropped as `noText`.
- Riskometers (detected by text; the classifier has no riskometer class) keep the
  title, any non-dial child (benchmark name) and the risk sentence.
- Charts: axis-tick items are dropped, merged `Label 3.44%` items split, then labels
  and values are paired by vertical-centre overlap (bars) or mutual nearest bbox
  (legends). Only a full 1:1 bijection with percentage totals <= 100.5% is emitted.
- Too many values per label (>= 1.5x and at least 2 more) is multi-series and never
  guessed; any other failure emits the raw child text.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, PictureItem, TextItem

from docling_service.normalize.text import is_value_only

DROPPED_CLASSES = {
    "logo": "logo",
    "signature": "signature",
    "stamp": "stamp",
    "qr_code": "qrCode",
    "bar_code": "barCode",
}
_TITLE_LABELS = {DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE}
_RISK_SENTENCE = re.compile(
    r"The risk of the (scheme|benchmark) is (Low to Moderate|Moderately High|Very High|Moderate|High|Low)\b"
)
_DIAL_WORDS = {"low", "moderate", "moderately", "high", "very", "risk", "riskometer", "igh", "to"}
_MERGED_VALUE = re.compile(r"^(.*[A-Za-z].*?)\s+([-+]?[₹$]?\d[\d,]*(?:\.\d+)?%|[-+]?[₹$]?\d[\d,]*\.\d+)$")
_NUMBER = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
MAX_PERCENT_TOTAL = 100.5
MULTI_SERIES_RATIO = 1.5


@dataclass(frozen=True)
class PictureResult:
    dropped: str | None
    text: str
    classification: str
    confidence: float
    pair_count: int
    flags: tuple[str, ...]
    child_refs: tuple[str, ...]


@dataclass(frozen=True)
class _Text:
    text: str
    box: BoundingBox

    @property
    def cy(self) -> float:
        return (self.box.t + self.box.b) / 2

    @property
    def cx(self) -> float:
        return (self.box.l + self.box.r) / 2


def classify(picture: PictureItem) -> tuple[str, float]:
    meta = picture.meta.classification if picture.meta else None
    if not meta or not meta.predictions:
        return "unknown", 0.0
    top = max(meta.predictions, key=lambda p: p.confidence)
    return top.class_name, round(float(top.confidence), 4)


def picture_children(picture: PictureItem, doc: DoclingDocument) -> list[TextItem]:
    out: list[TextItem] = []
    for ref in picture.children:
        node = ref.resolve(doc)
        if isinstance(node, TextItem):
            if node.text.strip():
                out.append(node)
        elif not isinstance(node, PictureItem):
            out.extend(picture_children(node, doc))
    return out


def normalize_picture(picture: PictureItem, doc: DoclingDocument) -> PictureResult:
    classification, confidence = classify(picture)
    children = picture_children(picture, doc)
    child_refs = tuple(c.self_ref for c in children)

    def result(text="", flags=(), pair_count=0, dropped=None) -> PictureResult:
        return PictureResult(dropped, text, classification, confidence, pair_count, tuple(flags), child_refs)

    if classification in DROPPED_CLASSES:
        return result(dropped=DROPPED_CLASSES[classification])
    if not children:
        return result(dropped="noText")

    title = next((c.text.strip() for c in children if c.label in _TITLE_LABELS), None)
    body = [c for c in children if not (c.label in _TITLE_LABELS and c.text.strip() == title)]
    head = [title] if title else []
    raw_lines = head + [c.text.strip() for c in body]

    sentences = [m.group(0) for c in body if (m := _RISK_SENTENCE.search(c.text))]
    if sentences:
        others = [c.text.strip() for c in body if not _RISK_SENTENCE.search(c.text) and not _is_dial_label(c.text)]
        return result("\n".join(head + others + sentences), ("picture_text_recovered", "riskometer_text_extracted"))

    items = [_Text(t, _box(c)) for c in body for t in [c.text.strip()] if not _is_axis_ticks(t)]
    items = [part for i in items for part in _split_merged(i)]
    values = [i for i in items if is_value_only(i.text)]
    labels = [i for i in items if not is_value_only(i.text)]

    if not values:
        return result("\n".join(raw_lines), ("picture_text_recovered",))
    if labels and len(values) >= MULTI_SERIES_RATIO * len(labels) and len(values) >= len(labels) + 2:
        return result("\n".join(raw_lines), ("picture_text_recovered", "chart_multi_series_unparsed"))

    paired = _pair_by_rows(labels, values) or _pair_by_nearest(labels, values)
    if paired and _percent_total_ok([v for _, v in paired[0]]):
        pairs, notes = paired
        lines = head + [f"{label.text.rstrip(':')}: {value.text}" for label, value in pairs] + [n.text for n in notes]
        return result("\n".join(lines), ("picture_text_recovered", "chart_pairs_extracted"), pair_count=len(pairs))
    return result("\n".join(raw_lines), ("picture_text_recovered", "chart_unpaired"))


def _box(item: TextItem) -> BoundingBox:
    box = item.prov[0].bbox
    if box.coord_origin != CoordOrigin.BOTTOMLEFT:
        page = item.prov[0].page_no
        raise ValueError(f"picture child on page {page} is not BOTTOMLEFT")
    return box


def _is_dial_label(text: str) -> bool:
    words = re.findall(r"[a-z]+", text.lower())
    return bool(words) and all(w in _DIAL_WORDS for w in words)


def _is_axis_ticks(text: str) -> bool:
    """One item with >= 3 evenly spaced numbers, e.g. `0% 10% 20% 30%`."""
    tokens = text.split()
    if len(tokens) < 3 or not all(is_value_only(t) for t in tokens):
        return False
    numbers = [float(_NUMBER.search(t).group(0).replace(",", "")) for t in tokens]
    steps = [b - a for a, b in zip(numbers, numbers[1:])]
    return all(math.isclose(s, steps[0], rel_tol=0.01, abs_tol=1e-9) for s in steps) and steps[0] != 0


def _split_merged(item: _Text) -> list[_Text]:
    """`Insurance 3.44%` -> label + value sharing the item bbox."""
    match = _MERGED_VALUE.match(item.text)
    if not match or is_value_only(match.group(1)):
        return [item]
    return [_Text(match.group(1).strip(), item.box), _Text(match.group(2), item.box)]


Pairing = tuple[list[tuple[_Text, _Text]], list[_Text]]


def _pair_by_rows(labels: list[_Text], values: list[_Text]) -> Pairing | None:
    """Horizontal bars: each value's vertical centre lies within exactly one label's extent."""
    low = min(v.box.b for v in values)
    high = max(v.box.t for v in values)
    pairs: list[tuple[_Text, _Text]] = []
    notes: list[_Text] = []
    used: set[int] = set()
    for label in labels:
        candidates = [i for i, v in enumerate(values) if label.box.b - 1 <= v.cy <= label.box.t + 1]
        if not candidates:
            if label.box.t < low or label.box.b > high:
                notes.append(label)
                continue
            return None
        if len(candidates) != 1 or candidates[0] in used:
            return None
        used.add(candidates[0])
        pairs.append((label, values[candidates[0]]))
    if len(used) != len(values):
        return None
    return pairs, notes


def _pair_by_nearest(labels: list[_Text], values: list[_Text]) -> Pairing | None:
    """Legends: mutual nearest neighbours by bbox centre, 1:1 only."""
    if not labels or len(labels) != len(values):
        return None

    def nearest(a: _Text, pool: list[_Text]) -> int:
        return min(range(len(pool)), key=lambda i: math.dist((a.cx, a.cy), (pool[i].cx, pool[i].cy)))

    pairs = []
    for i, label in enumerate(labels):
        j = nearest(label, values)
        if nearest(values[j], labels) != i:
            return None
        pairs.append((label, values[j]))
    return pairs, []


def _percent_total_ok(values: list[_Text]) -> bool:
    percents = [float(_NUMBER.search(v.text).group(0).replace(",", "")) for v in values if v.text.endswith("%")]
    return sum(percents) <= MAX_PERCENT_TOTAL
