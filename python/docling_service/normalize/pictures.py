"""Picture normalization from picture children (vector text) and bboxes. No VLM.

- Logos, signatures, stamps, QR/bar codes are dropped by classification; pictures
  without child text are dropped as `noText`.
- Riskometers (detected by text; the classifier has no riskometer class) keep the
  title, any non-dial child (benchmark name) and the risk sentence.
- Charts: axis-tick items are dropped, merged `Label 3.44%` items split, then labels
  and values are paired by vertical-centre overlap (bars), by colour (below), or by
  mutual nearest bbox (legends), in that order. Only a full 1:1 bijection with
  percentage totals <= 100.5% is emitted.
- Too many values per label (>= 1.5x and at least 2 more) is multi-series: never
  guessed by position, only paired by colour; any other failure emits the raw child text.

Title lines (`_title_labels`, needs the PDF's graphics): besides Docling's title/section
header child, the run of lines at the top of the picture that lie above every value, every
plot mark and every other label, carry no legend swatch, and are set larger (>= 1.1x the
other text) or bold. They are emitted first and never paired.

Colour pairing (`_pair_by_colour`, needs `chart_graphics.ChartGraphics` from the PDF):
- Legend: a label with a small square swatch just left of it (SWATCH_GAP) is a legend
  entry; a label line with several swatches (`Equity Holdings Cash & Other Receivables`)
  is cut at the swatches using the PDF's character positions.
- Each value's colour is the colour of its mark (separate axis-tick values are left out and
  emitted as one trailing line): the slice at the far end of a leader line
  starting at the value (the topmost filled path containing the end, at least ANCHOR_DEPTH
  inside it), else the mark containing the value's centre, else the bar beside it (rect
  marks spanning the value's centre across the bars' direction, gap <= BAR_REACH, runner-up
  BAR_MARGIN farther; the direction is the one in which most bars share a baseline).
  White/near-white fills, rectangles covering >= 40% of the picture (backgrounds), title
  bands, thin axis/grid lines and the legend swatches are no marks.
- Colours match in CIELAB (CIE76): legend colours must be >= LEGEND_MIN_DE apart, a value's
  colour within MATCH_MAX_DE of one legend colour and MATCH_MARGIN_DE closer to it than to
  any other. One value per legend entry, and percentages pass `_percent_total_ok`.
- Several values per series (FY return bars): each value's bar gives its series (colour)
  and its category (the nearest label of the row right below the bars, cut at wide gaps;
  half as far as the next one); emitted as `FY 24: Regular 35%; Direct 37%; Benchmark 40%`
  only when every value lands in its own (category, series) cell.
- A chart drawn as an image (no vector marks) samples colours from its rendered region:
  the dominant colour left of each label and around each value (DOMINANT_SHARE of the
  non-background pixels).
- When a legend is found but any of this is ambiguous, nothing is paired (no nearest
  fallback): the chart keeps its raw text and today's flag.
- A non-positive value (`-0.01%`, `0.00%`) has no slice of its own: when its mark is missing,
  belongs to a positive value, or its colour is a positive value's, it is set aside and the
  other values pair on their own; the chart stays `chart_unpaired` with the pairs, the
  unmatched legend names and the set-aside values as lines (no pairing by elimination).

Legends outside the picture (`outside_legend`, needs the PDF's graphics): Docling's picture bbox
can stop short of the legend (passive p63). Body text items on the picture's page next to the
picture are legend entries when they carry a swatch (same rules as inside: a 2-16 pt square
whose right edge is within SWATCH_GAP left of the text): scanned top to bottom below the picture
(overlapping it horizontally; each line's top within the legend reach of the picture's bottom or
of the claimed line above it, so a long legend (p69: seven lines) is taken whole), then right of
it and left of it (starting within the reach, overlapping it vertically). The reach is
min(NEAR_REACH = 60 pt, half the picture height): several legend line gaps at factsheet sizes
(p63's legend starts 5 pt below the picture, lines 14 pt apart), while a small icon cannot reach
far. Each band's scan stops at the first item that is not such a text (a heading, a table, a text
without a swatch, another chart) or lies beyond the reach. Claimed items join the picture chunk (text and itemRefs) and leave the
text chunks; `chunks.py` gives an item claimed by two pictures to neither.

`values_in_texts`: the chart's values (axis ticks left out) all appear, as the same numeric token,
in the given texts; `chunks.py` flags unbound charts whose values all appear in a table or
key-value chunk on their page `chart_values_in_table`.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from collections import Counter
from statistics import median

from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, PictureItem, TextItem

from docling_service.normalize.chart_graphics import NEAR_REACH, ChartGraphics, Char, Mark, delta_e, lab
from docling_service.normalize.text import is_value_only

DROPPED_CLASSES = {
    "logo": "logo",
    "signature": "signature",
    "stamp": "stamp",
    "qr_code": "qrCode",
    "bar_code": "barCode",
}
_TITLE_LABELS = {DocItemLabel.SECTION_HEADER, DocItemLabel.TITLE}
_HEADING_LABELS = _TITLE_LABELS | {DocItemLabel.CAPTION}
_RISK_SENTENCE = re.compile(
    r"The risk of the (scheme|benchmark) is (Low to Moderate|Moderately High|Very High|Moderate|High|Low)\b"
)
_DIAL_WORDS = {"low", "moderate", "moderately", "high", "very", "risk", "riskometer", "igh", "to"}
_MERGED_VALUE = re.compile(r"^(.*[A-Za-z].*?)\s+([-+]?[₹$]?\d[\d,]*(?:\.\d+)?%|[-+]?[₹$]?\d[\d,]*\.\d+)$")
_NUMBER = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
MAX_PERCENT_TOTAL = 100.5
MULTI_SERIES_RATIO = 1.5

# Colour pairing thresholds (points, CIE76 Delta E).
SWATCH_GAP = 12.0  # swatch right edge to label start
SWATCH_SIZE = (2.0, 16.0)
LEADER_REACH = 10.0  # leader's free end to value bbox
LEADER_MARGIN = 3.0  # next leader end at least this much farther
ANCHOR_DEPTH = 0.1  # leader end inside its slice
ANCHOR_REACH = 1.0
BAR_REACH = 4.0
BAR_MARGIN = 1.5
LEGEND_MIN_DE = 12.0
MATCH_MAX_DE = 5.0
MATCH_MARGIN_DE = 7.0
BACKGROUND_L = 90.0
TITLE_SIZE_RATIO = 1.1
TITLE_WEIGHT = 600
DOMINANT_SHARE = 0.6
LEGEND_REACH_SHARE = 0.5  # outside legends: at most this share of the picture height away
_EDGE = 2.0
_LEGEND_LABELS = {DocItemLabel.TEXT, DocItemLabel.LIST_ITEM}
_VALUE_TOKEN = re.compile(r"(?<![\w.])[-+\u2212\u2013]?[₹$]?\d[\d,]*(?:\.\d+)?%?")


@dataclass(frozen=True)
class PictureResult:
    dropped: str | None
    text: str
    classification: str
    confidence: float
    pair_count: int
    flags: tuple[str, ...]
    child_refs: tuple[str, ...]
    legend_refs: tuple[str, ...] = ()  # body text items outside the picture claimed as its legend
    values: tuple[str, ...] = ()  # chart values, axis ticks left out


@dataclass(frozen=True, eq=False)
class _Text:
    text: str
    box: BoundingBox
    heading: bool = False  # Docling title/section header/caption label

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


def normalize_picture(
    picture: PictureItem, doc: DoclingDocument, graphics: ChartGraphics | None = None, legend: list[TextItem] | None = None,
) -> PictureResult:
    """`graphics` (the picture's paths and characters from the PDF) enables title lines and
    colour pairing; without it charts pair by position only. `legend`: the body text items
    outside the picture that are its legend (default `outside_legend`)."""
    classification, confidence = classify(picture)
    children = picture_children(picture, doc)
    child_refs = tuple(c.self_ref for c in children)
    legend_refs: tuple[str, ...] = ()
    data_values: tuple[str, ...] = ()

    def result(text="", flags=(), pair_count=0, dropped=None) -> PictureResult:
        return PictureResult(dropped, text, classification, confidence, pair_count, tuple(flags), child_refs, legend_refs, data_values)

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

    items = [_Text(t, _box(c), c.label in _HEADING_LABELS) for c in body for t in [c.text.strip()] if not _is_axis_ticks(t)]
    items = [part for i in items for part in _split_merged(i)]
    values = [i for i in items if is_value_only(i.text)]
    labels = [i for i in items if not is_value_only(i.text)]

    if not values:
        return result("\n".join(raw_lines), ("picture_text_recovered",))
    if legend is None:
        legend = outside_legend(picture, doc, graphics)
    outside = [_Text(t.text.strip(), _box(t)) for t in legend]
    legend_refs = tuple(t.self_ref for t in legend)
    data_values = tuple(v.text for v in _drop_tick_values(values))
    raw_lines = raw_lines + [t.text for t in outside]
    multi = bool(labels or outside) and len(values) >= MULTI_SERIES_RATIO * len(labels + outside) and len(values) >= len(labels + outside) + 2
    unpaired = "chart_multi_series_unparsed" if multi else "chart_unpaired"

    title_item = next((_Text(c.text.strip(), _box(c), True) for c in children if c.label in _TITLE_LABELS and c.text.strip() == title), None)
    titles = _title_labels(labels, values, graphics, title_item) if graphics else []
    pool = [label for label in labels if label not in titles] + outside
    head = head + [t.text for t in titles]

    paired = None if multi else _pair_by_rows(pool, values)
    if paired is None and graphics is not None:
        by_colour = _pair_by_colour(pool, values, graphics, [t for t in (title_item, *titles) if t])
        if by_colour is _REFUSED:
            return result("\n".join(raw_lines), ("picture_text_recovered", unpaired))
        if isinstance(by_colour, _Partial):
            lines = (
                head + [f"{label.text.rstrip(':')}: {value.text}" for label, value in by_colour.pairs]
                + [t.text for t in (*by_colour.entries, *by_colour.values, *by_colour.notes)]
            )
            return result("\n".join(lines), ("picture_text_recovered", unpaired))
        if isinstance(by_colour, _Grid):
            lines = head + by_colour.lines + [n.text for n in by_colour.notes]
            return result("\n".join(lines), ("picture_text_recovered", "chart_pairs_extracted"), pair_count=by_colour.count)
        paired = by_colour
    if paired is None and not multi:
        paired = _pair_by_nearest(pool, values)
    if paired and _percent_total_ok([v for _, v in paired[0]]):
        pairs, notes = paired
        lines = head + [f"{label.text.rstrip(':')}: {value.text}" for label, value in pairs] + [n.text for n in notes]
        return result("\n".join(lines), ("picture_text_recovered", "chart_pairs_extracted"), pair_count=len(pairs))
    return result("\n".join(raw_lines), ("picture_text_recovered", unpaired))


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


# --- titles and colour pairing (needs the PDF's chart graphics) -----------------------------

_REFUSED = object()  # a legend was found but the colour evidence is ambiguous


@dataclass(frozen=True)
class _Grid:
    lines: list[str]
    notes: list[_Text]
    count: int


@dataclass(frozen=True)
class _Partial:
    """Positive values paired by colour; non-positive values without a slice of their own and the
    legend entries nobody matched stay unpaired."""

    pairs: list[tuple[_Text, _Text]]
    entries: list[_Text]
    values: list[_Text]
    notes: list[_Text]


@dataclass(frozen=True)
class _Entry:
    text: _Text
    rgb: tuple[int, int, int]


def _title_labels(labels: list[_Text], values: list[_Text], graphics: ChartGraphics, title: _Text | None) -> list[_Text]:
    """The top-most labels that lie above every value, plot mark and other label, have no legend
    swatch, hold a word, and are larger or bold (or Docling headings). Top to bottom."""
    swatches = [m for m in graphics.marks if _is_swatch(m)]
    marks = [m for m in graphics.marks if not _is_background(m, graphics)]
    ordered = sorted(labels, key=lambda label: -label.box.t)
    bands = [title] if title else []
    titles: list[_Text] = []
    for index, label in enumerate(ordered):
        rest = ordered[index + 1 :]
        plot = [m for m in marks if not _in_bands(m, [*bands, label])]
        floor = max([v.box.t for v in values] + [m.box[3] for m in plot] + [r.box.t for r in rest])
        if label.box.b < floor - 0.5 or _swatches_of(label, swatches) or not re.search(r"[A-Za-z]{2}", label.text):
            break
        if not (label.heading or _title_style(label, rest + values, graphics.chars)):
            break
        titles.append(label)
        bands.append(label)
    return titles


def _title_style(label: _Text, others: list[_Text], chars: tuple[Char, ...]) -> bool:
    own = _chars_in(label.box, chars)
    other = [c.size for o in others for c in _chars_in(o.box, chars)]
    if not own:
        return False
    size = Counter(c.size for c in own).most_common(1)[0][0]
    weight = Counter(c.weight for c in own).most_common(1)[0][0]
    return weight >= TITLE_WEIGHT or (bool(other) and size >= TITLE_SIZE_RATIO * median(other))


def _pair_by_colour(labels: list[_Text], values: list[_Text], graphics: ChartGraphics, titles: list[_Text]):
    """Pairing | _Grid | _REFUSED | None (no legend: colour does not apply)."""
    kept = _drop_tick_values(values)
    ticks = [v for v in values if v not in kept]
    values = kept
    if not graphics.marks:
        return _pair_raster(labels, values, graphics) if graphics.raster else None
    excluded = {id(m) for m in graphics.marks if _is_background(m, graphics) or _in_bands(m, titles)}
    swatches = [m for m in graphics.marks if id(m) not in excluded and _is_swatch(m)]
    swatches += [m for m in graphics.near_marks if _is_swatch(m)]
    legend = _legend(labels, swatches, graphics.chars + graphics.near_chars)
    if legend is None or legend is _REFUSED:
        return legend
    entries, legend_labels, used = legend
    if not _distinct([e.rgb for e in entries]):
        return _REFUSED
    excluded |= used
    plot = [m for m in graphics.marks if id(m) not in excluded and not _is_line(m)]
    marks = [_value_mark(v, plot, graphics) for v in values]
    series = [_match(m.rgb, [e.rgb for e in entries]) if m is not None else None for m in marks]
    aside = _set_aside(values, marks, series) if len(values) == len(entries) else set()
    kept = [i for i in range(len(values)) if i not in aside]
    if any(marks[i] is None for i in kept) or len({id(marks[i]) for i in kept}) != len(kept):
        return _REFUSED
    if any(series[i] is None for i in kept):
        return _REFUSED
    notes = [label for label in labels if id(label) not in legend_labels]
    if ticks:  # kept as one trailing line, in Docling order
        notes.append(_Text(" ".join(t.text for t in ticks), ticks[0].box))
    if aside:
        matched = {series[i]: values[i] for i in kept}
        if not kept or len(matched) != len(kept) or not _percent_total_ok(list(matched.values())):
            return _REFUSED
        return _Partial(
            [(entries[s].text, matched[s]) for s in sorted(matched)],
            [e.text for s, e in enumerate(entries) if s not in matched],
            [values[i] for i in sorted(aside)],
            notes,
        )
    if len(values) == len(entries):
        if sorted(series) != list(range(len(entries))):
            return _REFUSED
        by_entry = dict(zip(series, values))
        return [(entries[i].text, by_entry[i]) for i in range(len(entries))], notes
    if len(entries) >= 2 and len(values) > len(entries):
        return _series_grid(entries, values, marks, series, notes, graphics.chars)
    return _REFUSED


def _set_aside(values: list[_Text], marks: list[Mark | None], series: list[int | None]) -> set[int]:
    """Indexes of non-positive values with no slice of their own: no mark or legend colour, or the
    mark or colour of a positive value."""
    positive = [i for i, v in enumerate(values) if _number(v) > 0]
    taken_marks = {id(marks[i]) for i in positive if marks[i] is not None}
    taken_series = {series[i] for i in positive if series[i] is not None}
    return {
        i for i in range(len(values))
        if i not in positive
        and (marks[i] is None or id(marks[i]) in taken_marks or series[i] is None or series[i] in taken_series)
    }


def _number(value: _Text) -> float:
    return float(_NUMBER.search(value.text).group(0).replace(",", ""))


def _legend(labels: list[_Text], swatches: list[Mark], chars: tuple[Char, ...]):
    """([_Entry], ids of legend labels, ids of their swatches) | _REFUSED | None."""
    entries: list[_Entry] = []
    used: set[int] = set()
    for label in labels:
        own = _swatches_of(label, swatches)
        if not own:
            continue
        if own[0].box[2] > label.box.l + 1 or any(id(s) in used for s in own):
            return _REFUSED
        used.update(id(s) for s in own)
        if len(own) == 1:
            entries.append(_Entry(label, own[0].rgb))
            continue
        cuts = [s.box[0] for s in own[1:]]
        parts = _cut(label, chars, cuts)
        if parts is None:
            return _REFUSED
        entries += [_Entry(part, s.rgb) for part, s in zip(parts, own)]
    if not entries:
        return None
    return entries, {id(e.text) for e in entries} | {id(label) for label in labels if _swatches_of(label, swatches)}, used


def _swatches_of(label: _Text, swatches: list[Mark]) -> list[Mark]:
    """Swatches on the label's line from just left of it to its right end, left to right."""
    box = label.box
    return sorted(
        (
            s for s in swatches
            if box.b - 1 <= (s.box[1] + s.box[3]) / 2 <= box.t + 1 and box.l - SWATCH_GAP <= s.box[2] and s.box[2] <= box.r + 1
        ),
        key=lambda s: s.box[0],
    )


def _cut(label: _Text, chars: tuple[Char, ...], cuts: list[float]) -> list[_Text] | None:
    """Split a one-line label at x positions, mapping the PDF's characters back onto Docling's
    text (which must hold the same non-space characters)."""
    own = sorted(_chars_in(label.box, chars), key=lambda c: c.cx)
    if not own or max(c.cy for c in own) - min(c.cy for c in own) > 0.5 * max(c.size for c in own):
        return None  # several lines
    if "".join(c.text for c in own) != "".join(label.text.split()):
        return None
    groups: list[list[Char]] = [[] for _ in range(len(cuts) + 1)]
    for c in own:
        groups[sum(c.cx > x for x in cuts)].append(c)
    if any(not g for g in groups):
        return None
    out, at = [], 0
    text = label.text
    for group in groups:
        start = at
        count = 0
        while count < len(group):
            if not text[at].isspace():
                count += 1
            at += 1
        part = text[start:at].strip()
        box = BoundingBox(
            l=min(c.box[0] for c in group), b=min(c.box[1] for c in group), r=max(c.box[2] for c in group),
            t=max(c.box[3] for c in group), coord_origin=CoordOrigin.BOTTOMLEFT,
        )
        out.append(_Text(part, box))
    return out


def _value_mark(value: _Text, plot: list[Mark], graphics: ChartGraphics) -> Mark | None:
    box = value.box
    rect = (box.l, box.b, box.r, box.t)
    ends = []  # (distance from the value, line, the line's end inside the plot)
    for stroke in graphics.strokes:
        if _diagonal(stroke.box) > 120:
            continue
        for line in stroke.lines:
            if len(line) < 2 or math.dist(line[0], line[-1]) < 1:
                continue
            free = [not any(m.contains(p) for m in plot) for p in (line[0], line[-1])]
            if free == [True, False]:
                ends.append((_rect_distance(line[0], rect), id(line), line[-1]))
            elif free == [False, True]:
                ends.append((_rect_distance(line[-1], rect), id(line), line[0]))
    ends.sort(key=lambda e: e[0])
    if ends and ends[0][0] <= LEADER_REACH:
        if len(ends) > 1 and ends[1][0] < ends[0][0] + LEADER_MARGIN:
            return None
        return _mark_at(ends[0][2], plot)

    centre = (value.cx, value.cy)
    inside = [m for m in plot if m.contains(centre)]
    if inside:
        top = max(inside, key=lambda m: m.z)
        return top if top.edge_distance(centre) >= ANCHOR_DEPTH else None

    bars = [m for m in plot if _is_rect(m)]
    orientation = _orientation(bars)
    gaps = []
    for m in bars:
        l, b, r, t = m.box
        if l <= value.cx <= r and orientation != "horizontal":
            gaps.append((max(b - box.t, box.b - t, 0.0), m))
        elif b <= value.cy <= t and orientation != "vertical":
            gaps.append((max(l - box.r, box.l - r, 0.0), m))
    gaps.sort(key=lambda g: g[0])
    if not gaps or gaps[0][0] > BAR_REACH:
        return None
    if len(gaps) > 1 and gaps[1][0] < gaps[0][0] + BAR_MARGIN:
        return None
    return gaps[0][1]


def _orientation(bars: list[Mark]) -> str | None:
    """`vertical` when most bars start or end on one horizontal line (the value axis), `horizontal`
    when on one vertical line, else None."""
    if len(bars) < 2:
        return None
    for name, edges in (("vertical", lambda m: (m.box[1], m.box[3])), ("horizontal", lambda m: (m.box[0], m.box[2]))):
        counts = Counter(round(e) for m in bars for e in set(round(x) for x in edges(m)))
        if counts and counts.most_common(1)[0][1] >= 0.6 * len(bars):
            return name
    return None


def _mark_at(point: tuple[float, float], plot: list[Mark]) -> Mark | None:
    inside = [m for m in plot if m.contains(point)]
    if inside:
        top = max(inside, key=lambda m: m.z)
        return top if top.edge_distance(point) >= ANCHOR_DEPTH else None
    near = sorted(((m.edge_distance(point), m) for m in plot), key=lambda d: d[0])
    if not near or near[0][0] > ANCHOR_REACH:
        return None
    rivals = [d for d, m in near[1:] if delta_e(m.rgb, near[0][1].rgb) >= LEGEND_MIN_DE]
    if rivals and rivals[0] < near[0][0] + ANCHOR_REACH:
        return None
    return near[0][1]


def _match(rgb: tuple[int, int, int], colours: list[tuple[int, int, int]]) -> int | None:
    """Index of the legend colour `rgb` matches, None when none is close or the match is not clear."""
    distances = sorted((delta_e(rgb, c), i) for i, c in enumerate(colours))
    best, index = distances[0]
    if best > MATCH_MAX_DE:
        return None
    if len(distances) > 1 and distances[1][0] < best + MATCH_MARGIN_DE:
        return None
    return index


def _distinct(colours: list[tuple[int, int, int]]) -> bool:
    return all(delta_e(a, b) >= LEGEND_MIN_DE for i, a in enumerate(colours) for b in colours[i + 1 :])


def _series_grid(entries, values, marks, series, notes, chars) -> _Grid | object:
    """Values -> (category, series): series from the bar's colour, category from the row of labels
    right below the bars."""
    if not all(_is_rect(m) for m in marks):
        return _REFUSED
    bottom = min(m.box[1] for m in marks)
    below = [n for n in notes if n.box.t < bottom]
    if not below:
        return _REFUSED
    top = max(n.box.t for n in below)
    row = sorted((n for n in below if n.box.t >= top - 2), key=lambda n: n.box.l)
    categories = []
    for item in row:
        parts = _cut_at_gaps(item, chars)
        if parts is None:
            return _REFUSED
        categories += parts
    if len(categories) < 2:
        return _REFUSED
    cells: dict[tuple[int, int], _Text] = {}
    for value, mark, s in zip(values, marks, series):
        x = (mark.box[0] + mark.box[2]) / 2
        distances = sorted((abs(x - c.cx), i) for i, c in enumerate(categories))
        if distances[0][0] > 0.5 * distances[1][0]:
            return _REFUSED
        cell = (distances[0][1], s)
        if cell in cells:
            return _REFUSED
        cells[cell] = value
    if {c for c, _ in cells} != set(range(len(categories))) or {s for _, s in cells} != set(range(len(entries))):
        return _REFUSED
    lines = [
        f"{category.text}: " + "; ".join(f"{entries[s].text.text} {cells[(c, s)].text}" for s in range(len(entries)) if (c, s) in cells)
        for c, category in enumerate(categories)
    ]
    row_ids = {id(n) for n in row}
    return _Grid(lines, [n for n in notes if id(n) not in row_ids], len(values))


def _cut_at_gaps(label: _Text, chars: tuple[Char, ...]) -> list[_Text] | None:
    """`FY 26 FYTD 27` -> `FY 26`, `FYTD 27`: cut where the gap between characters exceeds 1.2x
    the font size (word spaces are ~0.3x)."""
    own = sorted(_chars_in(label.box, chars), key=lambda c: c.cx)
    if not own:
        return None
    size = median(c.size for c in own)
    cuts = [(a.box[2] + b.box[0]) / 2 for a, b in zip(own, own[1:]) if b.box[0] - a.box[2] > 1.2 * size]
    return _cut(label, chars, cuts) if cuts else [label]


def _drop_tick_values(values: list[_Text]) -> list[_Text]:
    """Remove axis tick labels: >= 4 values in one column (right edges within 1.5 pt) or row
    (centres within 0.5 pt) whose numbers step evenly with their position."""
    ticks: set[int] = set()
    for key, position, slack in ((lambda v: v.box.r, lambda v: v.cy, 1.5), (lambda v: v.cy, lambda v: v.cx, 0.5)):
        for anchor in values:
            group = sorted((v for v in values if abs(key(v) - key(anchor)) <= slack), key=position)
            if len(group) < 4:
                continue
            numbers = [float(_NUMBER.search(v.text).group(0).replace(",", "")) for v in group]
            places = [position(v) for v in group]
            steps = [b - a for a, b in zip(numbers, numbers[1:])]
            gaps = [b - a for a, b in zip(places, places[1:])]
            if steps[0] != 0 and all(math.isclose(s, steps[0], rel_tol=0.01) for s in steps) and all(
                abs(g - gaps[0]) <= max(1.0, 0.05 * abs(gaps[0])) for g in gaps
            ):
                ticks.update(id(v) for v in group)
    return [v for v in values if id(v) not in ticks]


def _pair_raster(labels: list[_Text], values: list[_Text], graphics: ChartGraphics):
    """Image charts: the dominant colour left of each label (its swatch) and around each value."""
    raster = graphics.raster
    entries = []
    for label in labels:
        box = label.box
        rgb = _dominant(raster, (box.l - SWATCH_GAP - 2, box.b, box.l - 0.5, box.t))
        if rgb is not None:
            entries.append(_Entry(label, rgb))
    if not entries:
        return None
    if len(entries) != len(values) or not _distinct([e.rgb for e in entries]):
        return _REFUSED
    series = []
    for value in values:
        box = value.box
        rgb = _dominant(raster, (box.l - 3, box.b - 3, box.r + 3, box.t + 3), hole=(box.l, box.b, box.r, box.t))
        series.append(_match(rgb, [e.rgb for e in entries]) if rgb else None)
    if any(s is None for s in series) or sorted(series) != list(range(len(entries))):
        return _REFUSED
    by_entry = dict(zip(series, values))
    legend = {id(e.text) for e in entries}
    return [(entries[i].text, by_entry[i]) for i in range(len(entries))], [n for n in labels if id(n) not in legend]


def _dominant(raster, region, hole=None) -> tuple[int, int, int] | None:
    """The most common colour among the region's pixels that are neither background (L* >=
    BACKGROUND_L) nor text-dark (L* < 20), if it holds DOMINANT_SHARE of them."""
    l, b, r, t = region
    counts: Counter = Counter()
    steps = max(1, int((r - l) * raster.scale)), max(1, int((t - b) * raster.scale))
    for i in range(steps[0]):
        for j in range(steps[1]):
            x, y = l + (i + 0.5) / raster.scale, b + (j + 0.5) / raster.scale
            if hole and hole[0] <= x <= hole[2] and hole[1] <= y <= hole[3]:
                continue
            rgb = raster.colour_at((x, y))
            if rgb is not None:
                counts[rgb] += 1
    lightness = {rgb: lab(rgb)[0] for rgb in counts}
    kept = {rgb: n for rgb, n in counts.items() if 20 <= lightness[rgb] < BACKGROUND_L}
    total = sum(kept.values())
    if total < 9:
        return None
    top = max(kept, key=lambda rgb: kept[rgb])
    share = sum(n for rgb, n in kept.items() if delta_e(rgb, top) <= MATCH_MAX_DE) / total
    return top if share >= DOMINANT_SHARE else None


def _chars_in(box: BoundingBox, chars: tuple[Char, ...]) -> list[Char]:
    return [c for c in chars if box.l - 0.5 <= c.cx <= box.r + 0.5 and box.b - 0.5 <= c.cy <= box.t + 0.5]


def _is_background(mark: Mark, graphics: ChartGraphics) -> bool:
    l, b, r, t = mark.box
    pl, pb, pr, pt = graphics.box
    return lab(mark.rgb)[0] >= BACKGROUND_L or ((r - l) * (t - b) >= 0.4 * (pr - pl) * (pt - pb) and _is_rect(mark))


def _in_bands(mark: Mark, texts: list[_Text]) -> bool:
    """A mark within the height of a title line (its background band, accent bar)."""
    return any(mark.box[1] >= t.box.b - 5 and mark.box[3] <= t.box.t + 5 for t in texts)


def _is_line(mark: Mark) -> bool:
    """An axis or grid line: a thin long rectangle (a thin pie sliver is a wedge, not a rect)."""
    l, b, r, t = mark.box
    return min(r - l, t - b) < 1.2 and max(r - l, t - b) > 20 and _is_rect(mark)


def _is_swatch(mark: Mark) -> bool:
    l, b, r, t = mark.box
    w, h = r - l, t - b
    low, high = SWATCH_SIZE
    return low <= w <= high and low <= h <= high and max(w, h) <= 1.6 * min(w, h) and _is_rect(mark)


def _is_rect(mark: Mark) -> bool:
    """One subpath filling its bbox (a bar, a swatch, a background); a ring with a hole is not."""
    l, b, r, t = mark.box
    area = (r - l) * (t - b)
    if area <= 0 or len(mark.rings) != 1:
        return False
    return 0.9 * area <= abs(_ring_area(mark.rings[0])) <= 1.1 * area


def _ring_area(ring) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1])) / 2


def _rect_distance(point, rect) -> float:
    x, y = point
    l, b, r, t = rect
    return math.hypot(max(l - x, 0.0, x - r), max(b - y, 0.0, y - t))


def _diagonal(box) -> float:
    return math.hypot(box[2] - box[0], box[3] - box[1])


# --- legends outside the picture, values in tables ------------------------------------------


def outside_legend(picture: PictureItem, doc: DoclingDocument, graphics: ChartGraphics | None) -> list[TextItem]:
    """Body text items next to a value-bearing chart that are its legend entries (module doc)."""
    if graphics is None or len(picture.prov) != 1:
        return []
    if not any(is_value_only(c.text) for c in picture_children(picture, doc)):
        return []
    swatches = [m for m in graphics.near_marks if _is_swatch(m)]
    if not swatches:
        return []
    page = picture.prov[0].page_no
    height = doc.pages[page].size.height
    l, b, r, t = graphics.box
    reach = min(NEAR_REACH, LEGEND_REACH_SHARE * (t - b))
    inner = {c.self_ref for p in doc.pictures for c in picture_children(p, doc)}
    notes = {ref.cref for x in [*doc.tables, *doc.pictures] for ref in [*x.captions, *x.footnotes]}
    bands: dict[str, list[tuple[float, object, BoundingBox]]] = {"below": [], "right": [], "left": []}
    for node, _ in doc.iterate_items(with_groups=False):
        prov = getattr(node, "prov", None)
        if node is picture or node.self_ref in inner or not prov or len(prov) != 1 or prov[0].page_no != page:
            continue
        if isinstance(node, PictureItem) and not picture_children(node, doc):
            continue  # icons and swatches Docling cut out as pictures
        if isinstance(node, TextItem) and not node.text.strip():
            continue
        bb = prov[0].bbox.to_bottom_left_origin(page_height=height)
        box = BoundingBox(l=min(bb.l, bb.r), b=min(bb.b, bb.t), r=max(bb.l, bb.r), t=max(bb.b, bb.t), coord_origin=CoordOrigin.BOTTOMLEFT)
        if box.t <= b + _EDGE and box.r > l and box.l < r:
            bands["below"].append((-box.t, node, box))
        elif box.t > b and box.b < t and r - _EDGE <= box.l <= r + reach:
            bands["right"].append((-box.t, node, box))
        elif box.t > b and box.b < t and l - reach <= box.r <= l + _EDGE:
            bands["left"].append((-box.t, node, box))
    claimed: list[TextItem] = []
    for name, band in bands.items():
        edge = b  # below: each line within the reach of the picture or the line above it
        for _, node, box in sorted(band, key=lambda e: e[0]):  # top to bottom
            if name == "below" and edge - box.t > reach:
                break
            if not isinstance(node, TextItem) or node.label not in _LEGEND_LABELS or node.self_ref in notes:
                break
            own = _swatches_of(_Text(node.text.strip(), box), swatches)
            if not own or own[0].box[2] > box.l + 1:
                break
            claimed.append(node)
            edge = box.b
    return claimed


def values_in_texts(values: tuple[str, ...], texts: list[str]) -> bool:
    """Every value appears in `texts` as the same numeric token (sign, currency and % included)."""
    if not values:
        return False
    found = {_value_token(m.group(0)) for text in texts for m in _VALUE_TOKEN.finditer(text)}
    return all(_value_token(v) in found for v in values)


def _value_token(text: str) -> str:
    return "".join(text.split()).replace("\u2212", "-").replace("\u2013", "-").removeprefix("+")
