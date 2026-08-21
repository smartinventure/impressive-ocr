# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recover the text a PDF page already carries, instead of throwing it away.

``hybrid`` and ``skip-if-text`` both decide that some pages do not need OCR because they
already have an extractable text layer. The engine then skipped those pages -- and dropped
them entirely. Nothing extracted the text it had just decided was good enough, so a mixed PDF
(a digital document with scanned pages appended, which is the exact case hybrid exists for)
came out missing every page that was already fine.

The log even said "Reusing the existing text layer on 3 of 5 pages" while reusing none of it.

This module is the missing half: read those pages with PyMuPDF and hand them back in the same
shape the engine produces, so a page's provenance stops mattering to everything downstream.
"""

from __future__ import annotations

from pathlib import Path

from ..core.errors import CorruptDocumentError
from ..engines.base import PageResult, TextBox

#: PyMuPDF reports coordinates in points at 72 DPI. Text boxes elsewhere are in the raster's
#: pixel space, so extracted text has to be scaled to match or a searchable PDF would place
#: its invisible layer at a fraction of the right size.
PDF_POINTS_PER_INCH = 72.0


def extract_page(source: Path, page_number: int, dpi: int) -> PageResult:
    """Read one 1-based page's existing text as a :class:`PageResult`.

    Produced in the raster coordinate space the OCR path uses, so a document whose pages came
    from both routes still yields one consistent set of boxes.
    """
    import pymupdf

    try:
        document = pymupdf.open(source)
    except Exception as error:
        raise CorruptDocumentError(f"Could not open {source.name}: {error}") from error

    try:
        if page_number < 1 or page_number > document.page_count:
            raise CorruptDocumentError(
                f"{source.name} has {document.page_count} page(s); asked for {page_number}"
            )

        page = document[page_number - 1]
        scale = dpi / PDF_POINTS_PER_INCH
        rect = page.rect

        boxes: list[TextBox] = []
        # "blocks" rather than "words": it preserves reading order and keeps a paragraph as
        # one region, which is what the OCR path also produces.
        for block in page.get_text("blocks"):
            x0, y0, x1, y1, text = block[0], block[1], block[2], block[3], str(block[4])
            cleaned = text.strip()
            if not cleaned:
                continue

            boxes.append(
                TextBox(
                    text=cleaned,
                    x0=float(x0) * scale,
                    y0=float(y0) * scale,
                    x1=float(x1) * scale,
                    y1=float(y1) * scale,
                    # Not a guess from a model: this text was authored, not recognised.
                    confidence=1.0,
                )
            )

        return PageResult(
            page_number=page_number,
            width=float(rect.width) * scale,
            height=float(rect.height) * scale,
            text_boxes=boxes,
            markdown=_as_markdown(boxes),
            # No Paddle result object exists for a page that was never inferred. Writers that
            # rely on `save_to_*` fall back to `text_boxes`, which is why both are carried.
            raw=None,
        )
    finally:
        document.close()


def _as_markdown(boxes: list[TextBox]) -> str:
    """Blocks joined as paragraphs.

    Deliberately plain. The point is that an already-digital page contributes its text to the
    output; inventing headings or tables from coordinates would be guessing where the OCR path
    has a model that actually decided.
    """
    return "\n\n".join(box.text for box in boxes)
