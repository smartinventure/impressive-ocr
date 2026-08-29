# SPDX-License-Identifier: AGPL-3.0-or-later
"""Text boxes from a PaddleOCR-VL result, which has none of the usual ones.

PP-StructureV3 runs a detector and a recogniser, so its result carries `rec_texts` beside
`rec_polys` and the searchable-PDF writer has a box per line. PaddleOCR-VL has no detection
stage at all -- one 0.9B model decodes each layout region straight into text -- so it carries
`parsing_res_list` instead: one entry per block, with `block_content`, `block_bbox` and
`block_label`.

Nothing read that, so `extract_text_boxes` returned `[]` for every VL page and the searchable
PDF came out with the page images and an empty text layer. It reported success: the writer
skipped each page silently, and the adapter's own warning about exactly this could not fire
because it also required the markdown to be empty, which it never is on this engine.

The granularity is the honest cost. A block is a paragraph, not a word, so selecting text in
the resulting PDF selects the paragraph. Multi-line content is split across the block's height
so the lines land roughly where they are on the page rather than as one stretched string, but
this cannot be as precise as a real detector. The fast profile stays word-level.
"""

from __future__ import annotations

from typing import Any

from .base import TextBox

#: Blocks whose content is not text worth laying under the page.
#:
#: A figure's `block_content` is a path or an empty string, and an invisible caption stretched
#: across a photograph would be selectable nonsense sitting on top of it.
_NON_TEXT_LABELS = frozenset({"image", "figure", "chart", "seal", "formula_number"})


def extract_vl_boxes(payload: dict[str, Any]) -> list[TextBox]:
    """Boxes from `parsing_res_list`, or an empty list when that is not what this is."""
    blocks = payload.get("parsing_res_list")
    if not isinstance(blocks, list):
        return []

    boxes: list[TextBox] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if str(block.get("block_label", "")).lower() in _NON_TEXT_LABELS:
            continue

        bounds = _block_bounds(block.get("block_bbox"))
        if bounds is None:
            continue

        content = block.get("block_content")
        if not isinstance(content, str) or not content.strip():
            continue

        boxes.extend(_lines_within(content, bounds))

    return boxes


def _block_bounds(raw: Any) -> tuple[float, float, float, float] | None:
    """`block_bbox` is a flat [x0, y0, x1, y1] in recognition pixels."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(value) for value in raw)
    except (TypeError, ValueError):
        return None
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _lines_within(content: str, bounds: tuple[float, float, float, float]) -> list[TextBox]:
    """Share the block's height between its lines.

    One box for the whole block would stretch a paragraph's text across its full height as a
    single line, so a search hit would highlight the entire paragraph and the invisible text
    would sit nowhere near the words underneath it. Dividing by the line count keeps each line
    within a line's worth of space, which is as close as a block-level result allows.
    """
    lines = [line.strip() for line in content.splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return []

    x0, y0, x1, y1 = bounds
    height = (y1 - y0) / len(lines)

    return [
        TextBox(
            text=line,
            x0=x0,
            y0=y0 + index * height,
            x1=x1,
            y1=y0 + (index + 1) * height,
            # No per-block score is reported, and a made-up one would be worse than none:
            # nothing consumes this beyond the writer, which ignores it.
            confidence=1.0,
        )
        for index, line in enumerate(lines)
    ]
