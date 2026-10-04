"""Vector graphics and characters inside chart pictures, read from the source PDF via PDFium.

Charts in the factsheets are vector drawings: every slice, bar, legend swatch and leader line is
a path object with a fill or stroke colour. `picture_graphics` collects, per chart picture, the
filled paths (`Mark`: colour, flattened outline, paint order), the stroke-only paths (`Stroke`:
leader lines, axes) and the characters (`Char`: text, box, rendered size, weight) that lie inside
the picture's bbox. `pictures.py` binds values to legend names by colour with them.

Reading follows `headings.header_font_sizes`: under Docling's pypdfium2 lock, pages whose size
differs from the converted page are skipped. Paths inside form XObjects are transformed into page
space. Bezier curves are flattened (BEZIER_STEPS points per curve). Clipping is ignored.

A chart drawn as an embedded image (no marks inside its bbox, an image object overlapping it, and
value labels among its children) gets `raster` instead: the picture region rendered at
RASTER_SCALE, from which `colour_at` reads pixel colours.
"""

from __future__ import annotations

import ctypes
import math
from dataclasses import dataclass, field

from docling_core.types.doc import DoclingDocument, PictureItem

Point = tuple[float, float]
Box = tuple[float, float, float, float]  # l, b, r, t (bottom-left origin, page points)

BEZIER_STEPS = 8
RASTER_SCALE = 4.0
_PAGE_SIZE_TOLERANCE = 0.5
_SLACK = 2.0


@dataclass(frozen=True)
class Mark:
    """A filled path: `rings` are its closed subpaths, `even_odd` its fill rule, `z` paint order."""

    rgb: tuple[int, int, int]
    box: Box
    rings: tuple[tuple[Point, ...], ...]
    even_odd: bool
    z: int

    def contains(self, point: Point) -> bool:
        x, y = point
        l, b, r, t = self.box
        if not (l <= x <= r and b <= y <= t):
            return False
        winding = 0
        crossings = 0
        for ring in self.rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 <= y) != (y2 <= y):
                    at = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                    if at > x:
                        crossings += 1
                        winding += 1 if y2 > y1 else -1
        return crossings % 2 == 1 if self.even_odd else winding != 0

    def distance(self, point: Point) -> float:
        """0 inside, else the distance to the outline."""
        if self.contains(point):
            return 0.0
        return self.edge_distance(point)

    def edge_distance(self, point: Point) -> float:
        return min(
            (_segment_distance(point, a, b) for ring in self.rings for a, b in zip(ring, ring[1:] + ring[:1])),
            default=math.inf,
        )


@dataclass(frozen=True)
class Stroke:
    """A stroked, unfilled path (leader line, axis): its subpaths as polylines."""

    rgb: tuple[int, int, int]
    box: Box
    lines: tuple[tuple[Point, ...], ...]

    @property
    def ends(self) -> list[Point]:
        return [p for line in self.lines if len(line) >= 2 for p in (line[0], line[-1])]


@dataclass(frozen=True)
class Char:
    text: str
    box: Box
    size: float  # rendered size, pt
    weight: int

    @property
    def cx(self) -> float:
        return (self.box[0] + self.box[2]) / 2

    @property
    def cy(self) -> float:
        return (self.box[1] + self.box[3]) / 2


@dataclass(frozen=True)
class Raster:
    """The picture region rendered at `scale` px/pt; `origin` is the region's (l, t) in page points."""

    width: int
    height: int
    pixels: bytes  # RGB, row-major from the top
    origin: Point
    scale: float

    def colour_at(self, point: Point) -> tuple[int, int, int] | None:
        x = int((point[0] - self.origin[0]) * self.scale)
        y = int((self.origin[1] - point[1]) * self.scale)
        if not (0 <= x < self.width and 0 <= y < self.height):
            return None
        at = (y * self.width + x) * 3
        return self.pixels[at], self.pixels[at + 1], self.pixels[at + 2]


@dataclass(frozen=True)
class ChartGraphics:
    box: Box
    marks: tuple[Mark, ...] = ()
    strokes: tuple[Stroke, ...] = ()
    chars: tuple[Char, ...] = ()
    raster: Raster | None = field(default=None, repr=False)


def picture_graphics(doc: DoclingDocument, pdf: bytes, pictures: list[PictureItem] | None = None) -> dict[str, ChartGraphics]:
    """picture self_ref -> its graphics, for every picture (or `pictures`) with a single prov on a
    page of `pdf` whose size matches the converted page."""
    import pypdfium2
    import pypdfium2.raw as pdfium_c
    from docling.utils.locks import pypdfium2_lock

    by_page: dict[int, list[PictureItem]] = {}
    for picture in doc.pictures if pictures is None else pictures:
        if len(picture.prov) == 1 and picture.children:
            by_page.setdefault(picture.prov[0].page_no, []).append(picture)
    if not by_page:
        return {}

    out: dict[str, ChartGraphics] = {}
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
                    marks, strokes, images = _page_paths(page, pdfium_c)
                    chars = _page_chars(page, pdfium_c)
                    for picture in items:
                        bb = picture.prov[0].bbox.to_bottom_left_origin(page_height=expected.height)
                        box = (min(bb.l, bb.r), min(bb.b, bb.t), max(bb.l, bb.r), max(bb.b, bb.t))
                        inside = [m for m in marks if _within(m.box, box)]
                        raster = None
                        if not inside and any(_overlaps(i, box) for i in images) and _has_values(picture, doc):
                            raster = _render(page, box, height)
                        out[picture.self_ref] = ChartGraphics(
                            box=box,
                            marks=tuple(inside),
                            strokes=tuple(s for s in strokes if _within(s.box, box)),
                            chars=tuple(c for c in chars if _within(c.box, box)),
                            raster=raster,
                        )
                finally:
                    page.close()
        finally:
            document.close()
    return out


def _has_values(picture: PictureItem, doc: DoclingDocument) -> bool:
    """Only charts with value labels can use sampled colours (logos and riskometers are skipped)."""
    from docling_service.normalize.pictures import picture_children
    from docling_service.normalize.text import is_value_only

    return any(is_value_only(c.text) for c in picture_children(picture, doc))


def _within(inner: Box, outer: Box) -> bool:
    return (
        inner[0] >= outer[0] - _SLACK and inner[1] >= outer[1] - _SLACK
        and inner[2] <= outer[2] + _SLACK and inner[3] <= outer[3] + _SLACK
    )


def _overlaps(a: Box, b: Box) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _page_paths(page, pdfium_c) -> tuple[list[Mark], list[Stroke], list[Box]]:
    marks: list[Mark] = []
    strokes: list[Stroke] = []
    images: list[Box] = []
    identity = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

    def walk(obj, parent) -> None:
        kind = pdfium_c.FPDFPageObj_GetType(obj)
        matrix = _compose(_matrix(obj, pdfium_c), parent)
        if kind == pdfium_c.FPDF_PAGEOBJ_FORM:
            for i in range(pdfium_c.FPDFFormObj_CountObjects(obj)):
                walk(pdfium_c.FPDFFormObj_GetObject(obj, i), matrix)
            return
        if kind == pdfium_c.FPDF_PAGEOBJ_IMAGE:
            images.append(_bounds(obj, pdfium_c, parent))
            return
        if kind != pdfium_c.FPDF_PAGEOBJ_PATH:
            return
        fill_mode, stroked = ctypes.c_int(), ctypes.c_int()
        if not pdfium_c.FPDFPath_GetDrawMode(obj, ctypes.byref(fill_mode), ctypes.byref(stroked)):
            return
        lines = _path_lines(obj, pdfium_c, matrix)
        points = [p for line in lines for p in line]
        if not points:
            return
        box = (min(x for x, _ in points), min(y for _, y in points), max(x for x, _ in points), max(y for _, y in points))
        if fill_mode.value:
            rgb = _colour(obj, pdfium_c, pdfium_c.FPDFPageObj_GetFillColor)
            if rgb is not None:
                rings = tuple(tuple(line) for line in lines if len(line) >= 3)
                if rings:
                    marks.append(Mark(rgb, box, rings, fill_mode.value == pdfium_c.FPDF_FILLMODE_ALTERNATE, len(marks)))
        elif stroked.value:
            rgb = _colour(obj, pdfium_c, pdfium_c.FPDFPageObj_GetStrokeColor)
            if rgb is not None:
                strokes.append(Stroke(rgb, box, tuple(tuple(line) for line in lines if len(line) >= 2)))

    for index in range(pdfium_c.FPDFPage_CountObjects(page)):
        walk(pdfium_c.FPDFPage_GetObject(page, index), identity)
    return marks, strokes, images


def _matrix(obj, pdfium_c) -> tuple[float, ...]:
    m = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(obj, ctypes.byref(m)):
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    return (m.a, m.b, m.c, m.d, m.e, m.f)


def _compose(inner: tuple[float, ...], outer: tuple[float, ...]) -> tuple[float, ...]:
    """inner then outer (PDF row-vector convention)."""
    a, b, c, d, e, f = inner
    A, B, C, D, E, F = outer
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


def _apply(m: tuple[float, ...], x: float, y: float) -> Point:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _bounds(obj, pdfium_c, parent) -> Box:
    l, b, r, t = (ctypes.c_float() for _ in range(4))
    pdfium_c.FPDFPageObj_GetBounds(obj, ctypes.byref(l), ctypes.byref(b), ctypes.byref(r), ctypes.byref(t))
    corners = [_apply(parent, x, y) for x in (l.value, r.value) for y in (b.value, t.value)]
    return (min(x for x, _ in corners), min(y for _, y in corners), max(x for x, _ in corners), max(y for _, y in corners))


def _colour(obj, pdfium_c, getter) -> tuple[int, int, int] | None:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if not getter(obj, ctypes.byref(r), ctypes.byref(g), ctypes.byref(b), ctypes.byref(a)) or a.value == 0:
        return None
    return (r.value, g.value, b.value)


def _path_lines(obj, pdfium_c, matrix) -> list[list[Point]]:
    """Subpaths in page space, curves flattened."""
    lines: list[list[Point]] = []
    pending: list[Point] = []  # bezier control points
    x, y = ctypes.c_float(), ctypes.c_float()
    for index in range(pdfium_c.FPDFPath_CountSegments(obj)):
        segment = pdfium_c.FPDFPath_GetPathSegment(obj, index)
        if not pdfium_c.FPDFPathSegment_GetPoint(segment, ctypes.byref(x), ctypes.byref(y)):
            continue
        point = _apply(matrix, x.value, y.value)
        kind = pdfium_c.FPDFPathSegment_GetType(segment)
        if kind == pdfium_c.FPDF_SEGMENT_MOVETO or not lines:
            lines.append([point])
            pending = []
        elif kind == pdfium_c.FPDF_SEGMENT_BEZIERTO:
            pending.append(point)
            if len(pending) == 3:
                start = lines[-1][-1]
                c1, c2, end = pending
                lines[-1].extend(_bezier(start, c1, c2, end))
                pending = []
        else:
            lines[-1].append(point)
            pending = []
    return lines


def _bezier(p0: Point, p1: Point, p2: Point, p3: Point) -> list[Point]:
    out = []
    for step in range(1, BEZIER_STEPS + 1):
        t = step / BEZIER_STEPS
        u = 1 - t
        out.append((
            u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
        ))
    return out


def _page_chars(page, pdfium_c) -> list[Char]:
    text_page = page.get_textpage()
    try:
        out = []
        left, right, bottom, top = (ctypes.c_double() for _ in range(4))
        matrix = pdfium_c.FS_MATRIX()
        for index in range(pdfium_c.FPDFText_CountChars(text_page)):
            code = pdfium_c.FPDFText_GetUnicode(text_page, index)
            if code <= 32:
                continue
            if not pdfium_c.FPDFText_GetCharBox(text_page, index, ctypes.byref(left), ctypes.byref(right), ctypes.byref(bottom), ctypes.byref(top)):
                continue
            scale = 1.0
            if pdfium_c.FPDFText_GetMatrix(text_page, index, ctypes.byref(matrix)):
                scale = math.sqrt(abs(matrix.a * matrix.d - matrix.b * matrix.c))
            size = round(pdfium_c.FPDFText_GetFontSize(text_page, index) * scale, 1)
            weight = pdfium_c.FPDFText_GetFontWeight(text_page, index)
            out.append(Char(chr(code), (left.value, bottom.value, right.value, top.value), size, weight))
        return out
    finally:
        text_page.close()


def _render(page, box: Box, page_height: float) -> Raster:
    l, b, r, t = box
    bitmap = page.render(
        scale=RASTER_SCALE,
        crop=(l, b, page.get_width() - r, page.get_height() - t),
        rev_byteorder=True,
    )
    try:
        image = bitmap.to_pil().convert("RGB")
    finally:
        bitmap.close()
    return Raster(image.width, image.height, image.tobytes(), (l, t), RASTER_SCALE)


def _segment_distance(p: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    if length == 0:
        return math.dist(p, a)
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return math.dist(p, (a[0] + t * dx, a[1] + t * dy))


# --- colour ------------------------------------------------------------------


def lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """sRGB (0-255) -> CIELAB (D65)."""

    def linear(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(v: float) -> float:
        return v ** (1 / 3) if v > 216 / 24389 else (24389 / 27 * v + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def delta_e(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    """CIE76 colour difference."""
    return math.dist(lab(a), lab(b))
