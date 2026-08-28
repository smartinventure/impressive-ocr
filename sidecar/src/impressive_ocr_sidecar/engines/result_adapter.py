# SPDX-License-Identifier: AGPL-3.0-or-later
"""Normalises PaddleOCR result objects into our :class:`PageResult`.

PaddleOCR's per-page result object is not a documented, stable API — its attribute names
have moved between 3.x releases and differ between PP-StructureV3 and PaddleOCR-VL. The
documented, stable surface is ``predict()`` plus the ``save_to_*`` methods, which is what
the writers use for Markdown/JSON/DOCX/XLSX/HTML.

This module only extracts what those methods cannot give us: plain text (for ``.txt``) and
word boxes (for the searchable-PDF text layer). It therefore probes several known shapes
and degrades to an empty result rather than raising — a shape change should cost a format,
not the whole job.
"""

from __future__ import annotations

from typing import Any

from ..core.logging import get_logger
from .base import PageResult, TextBox
from .chart_text import append_chart_text

_logger = get_logger()

# Attribute/key names seen across PaddleOCR 3.3 to 3.7 for the same concept.
_MARKDOWN_KEYS = ("markdown_texts", "markdown", "md_text")
_TEXT_KEYS = ("rec_texts", "texts", "text")
_BOX_KEYS = ("rec_polys", "dt_polys", "boxes", "rec_boxes")
_SCORE_KEYS = ("rec_scores", "scores")
#: Where PP-StructureV3 hides the page-wide OCR result. See :func:`_ocr_payload`.
_NESTED_OCR_KEY = "overall_ocr_res"


def _as_mapping(result: Any) -> dict[str, Any]:
    """Best-effort view of a result object as a plain dict."""
    for attribute in ("json", "res", "_res"):
        value = getattr(result, attribute, None)
        if isinstance(value, dict):
            # Paddle nests the payload one level deep under "res" in some versions.
            return value.get("res", value) if isinstance(value.get("res"), dict) else value
    if isinstance(result, dict):
        return result
    return {}


def _first_present(source: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def _ocr_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the mapping that actually carries the recognition arrays.

    ``PaddleOCR.predict`` puts ``rec_texts``/``rec_polys`` at the top level, but
    ``PPStructureV3.predict`` reserves the top level for layout blocks and nests the
    page-wide OCR result under ``overall_ocr_res``. Descending to whichever level holds the
    text keeps one extraction path for both engines instead of forking on pipeline type.

    Without this the structure engine silently produced **zero** text boxes: the pipeline
    ran to completion, so nothing failed loudly — the page just came back empty.
    """
    if _first_present(payload, _TEXT_KEYS) is not None:
        return payload
    nested = payload.get(_NESTED_OCR_KEY)
    return nested if isinstance(nested, dict) else payload


def extract_markdown(result: Any) -> str:
    """Pull the Markdown rendering out of a result object, or return an empty string."""
    markdown = getattr(result, "markdown", None)
    if isinstance(markdown, str):
        return markdown
    if isinstance(markdown, dict):
        value = _first_present(markdown, _MARKDOWN_KEYS)
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return "\n\n".join(str(item) for item in value)

    value = _first_present(_as_mapping(result), _MARKDOWN_KEYS)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n\n".join(str(item) for item in value)
    return ""


def _polygon_bounds(polygon: Any) -> tuple[float, float, float, float] | None:
    """Reduce a polygon or box in any of Paddle's shapes to (x0, y0, x1, y1)."""
    try:
        points = [tuple(float(coordinate) for coordinate in point) for point in polygon]
    except (TypeError, ValueError):
        # Already a flat [x0, y0, x1, y1] box.
        try:
            flat = [float(value) for value in polygon]
        except (TypeError, ValueError):
            return None
        if len(flat) != 4:
            return None
        x0, y0, x1, y1 = flat
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    if not points:
        return None
    xs = [point[0] for point in points if len(point) >= 2]
    ys = [point[1] for point in points if len(point) >= 2]
    if not xs or not ys:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def extract_text_boxes(result: Any) -> list[TextBox]:
    """Pull recognised strings with their bounding boxes.

    Returns an empty list when the shape is unrecognised; the searchable-PDF writer then
    reports that it cannot produce a text layer rather than emitting an empty one.
    """
    payload = _ocr_payload(_as_mapping(result))
    texts = _first_present(payload, _TEXT_KEYS)
    polygons = _first_present(payload, _BOX_KEYS)

    if not isinstance(texts, list) or not isinstance(polygons, list):
        return []

    scores = _first_present(payload, _SCORE_KEYS)
    scores_list = scores if isinstance(scores, list) else []

    boxes: list[TextBox] = []
    for index, text in enumerate(texts):
        if index >= len(polygons):
            break
        bounds = _polygon_bounds(polygons[index])
        if bounds is None:
            continue
        confidence = 1.0
        if index < len(scores_list):
            try:
                confidence = float(scores_list[index])
            except (TypeError, ValueError):
                confidence = 1.0
        x0, y0, x1, y1 = bounds
        boxes.append(TextBox(text=str(text), x0=x0, y0=y0, x1=x1, y1=y1, confidence=confidence))
    return boxes


def to_page_result(
    result: Any,
    *,
    page_number: int,
    width: float,
    height: float,
) -> PageResult:
    """Build a :class:`PageResult` from one PaddleOCR page result."""
    boxes = extract_text_boxes(result)
    markdown = extract_markdown(result)

    # Paddle's Markdown replaces a chart with an image reference, dropping every string the
    # same run already recognised inside it. The txt and searchable-PDF writers use `boxes`
    # and never lost them; this is what stops the Markdown writer being the one format that
    # silently returns less.
    markdown = append_chart_text(markdown, result, boxes, height)

    if not boxes and not markdown:
        _logger.warning(
            "Could not extract text from the PaddleOCR result; "
            "txt and searchable-pdf output will be empty for this page",
            extra={"page": page_number, "resultType": type(result).__name__},
        )

    return PageResult(
        page_number=page_number,
        width=width,
        height=height,
        markdown=markdown,
        text="\n".join(box.text for box in boxes) if boxes else _plain_text_fallback(markdown),
        text_boxes=boxes,
        raw=result,
    )


def _plain_text_fallback(markdown: str) -> str:
    """Strip the most common Markdown decorations so ``.txt`` is not full of syntax."""
    if not markdown:
        return ""
    lines: list[str] = []
    for line in markdown.splitlines():
        stripped = line.lstrip("#").strip()
        if stripped.startswith("|") and set(stripped) <= set("|-: "):
            continue  # table separator row
        lines.append(stripped)
    return "\n".join(lines)
