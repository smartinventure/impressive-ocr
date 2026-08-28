# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover the text PaddleOCR recognised inside a chart but left out of the Markdown.

PP-StructureV3 runs one page-wide OCR pass and, separately, assembles a Markdown document
from the layout blocks. A block it labels ``chart`` becomes an image reference in that
document, so every string inside the plot area -- axis ticks, legend entries, category names
-- is dropped on the way out, even though it was recognised a moment earlier and is sitting
in ``overall_ocr_res``.

Measured on ``samples/charts/``, that is the difference between 0-30% of a chart's text
reaching the Markdown file and 94-97% reaching the txt and searchable-PDF files from the very
same run. The recognition was never the problem, and no second model fixes it: the text is
already paid for.

This module puts it back, and nothing here runs inference.
"""

from __future__ import annotations

import re
from typing import Any

from .base import TextBox

#: Layout labels whose contents Paddle replaces with an image reference.
#:
#: ``figure`` and ``image`` are included because the same suppression applies to them, and a
#: chart misfiled as either would otherwise keep losing its text for a reason the user cannot
#: see. A photograph contributes no text boxes, so including it costs nothing.
CHART_LABELS = frozenset({"chart", "figure", "image"})

#: Rows within this fraction of the page height count as the same line for ordering.
_ROW_TOLERANCE = 0.012

Bounds = tuple[float, float, float, float]


def _as_mapping(result: Any) -> dict[str, Any]:
    for attribute in ("json", "res", "_res"):
        value = getattr(result, attribute, None)
        if isinstance(value, dict):
            return value.get("res", value) if isinstance(value.get("res"), dict) else value
    return result if isinstance(result, dict) else {}


def chart_regions(result: Any) -> list[Bounds]:
    """Bounding boxes of the layout blocks whose text the Markdown will not contain."""
    payload = _as_mapping(result)
    layout = payload.get("layout_det_res")
    blocks = layout.get("boxes") if isinstance(layout, dict) else None
    if not isinstance(blocks, list):
        return []

    regions: list[Bounds] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if str(block.get("label", "")).lower() not in CHART_LABELS:
            continue
        coordinate = block.get("coordinate")
        if not isinstance(coordinate, (list, tuple)) or len(coordinate) != 4:
            continue
        try:
            x0, y0, x1, y1 = (float(value) for value in coordinate)
        except (TypeError, ValueError):
            continue
        regions.append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
    return regions


def boxes_within(boxes: list[TextBox], regions: list[Bounds]) -> list[TextBox]:
    """The text boxes whose centre falls inside one of the regions.

    Centre rather than full containment: detection boxes routinely overhang the layout block
    by a pixel or two, and requiring containment would drop exactly the axis labels that sit
    against the frame.
    """
    if not regions:
        return []

    inside: list[TextBox] = []
    for box in boxes:
        centre_x = (box.x0 + box.x1) / 2
        centre_y = (box.y0 + box.y1) / 2
        if any(x0 <= centre_x <= x1 and y0 <= centre_y <= y1 for x0, y0, x1, y1 in regions):
            inside.append(box)
    return inside


def _reading_order(boxes: list[TextBox], page_height: float) -> list[TextBox]:
    """Top to bottom, then left to right, with a tolerance so a row stays a row."""
    tolerance = max(page_height * _ROW_TOLERANCE, 1.0)
    return sorted(boxes, key=lambda box: (round(box.y0 / tolerance), box.x0))


def _normalise(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def append_chart_text(markdown: str, result: Any, boxes: list[TextBox], height: float) -> str:
    """Append the chart's own text to `markdown`, skipping anything already in it.

    Returns `markdown` unchanged when there is no chart region, nothing was recognised inside
    one, or the document already contains every string -- so a page without charts is
    untouched and running this twice changes nothing.
    """
    regions = chart_regions(result)
    if not regions:
        return markdown

    inside = boxes_within(boxes, regions)
    if not inside:
        return markdown

    present = _normalise(markdown)
    lines: list[str] = []
    seen: set[str] = set()
    for box in _reading_order(inside, height):
        text = box.text.strip()
        key = _normalise(text)
        # A chart legend repeats its own labels; the title is usually in the Markdown
        # already. Neither is worth emitting twice.
        if not key or key in seen or key in present:
            continue
        seen.add(key)
        lines.append(text)

    if not lines:
        return markdown

    block = "\n".join(lines)
    separator = "\n\n" if markdown.strip() else ""
    return f"{markdown.rstrip()}{separator}{block}\n"
