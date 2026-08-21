# SPDX-License-Identifier: AGPL-3.0-or-later
"""Searchable PDF: the original pages, with the recognised text laid invisibly on top.

PaddleOCR cannot produce this. Its result objects expose ``save_to_word``, ``save_to_html``,
``save_to_xlsx``, ``save_to_markdown`` and ``save_to_latex`` — there is no PDF among them —
so this writer is ours, built on PyMuPDF, which is already a dependency for rasterising.

The page a user sees is untouched: their scan, byte for byte where the source was a PDF. The
text goes on in render mode 3 (fill and stroke both off), which draws nothing but is selected,
copied, indexed and searched exactly like ordinary text. That is what makes the result useful
to a document management system while still looking like the original.

Positioning is per text box, not per page: each box's font size is chosen so the invisible
string spans the same width as the ink underneath it. Selecting a line in a viewer therefore
highlights the words it belongs to, rather than a rectangle that drifts across the page.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf

from ..core.config import bundled_font_path
from ..core.errors import OutputWriteError
from ..core.logging import get_logger
from ..core.protocol import OutputFormat
from ..engines.base import DocumentResult, PageResult
from .base import WriteContext, WrittenFile, measure

_logger = get_logger()

#: Fill and stroke both disabled: the glyphs are laid out and selectable, and draw nothing.
_INVISIBLE_RENDER_MODE = 3

#: Internal name for the embedded font. Arbitrary, but must be stable within a page.
_FONT_ALIAS = "ocr-invisible"

#: A box's height is the line box, which is taller than the glyphs inside it. Starting here
#: and shrinking to fit the width keeps descenders inside the box on ordinary prose.
_HEIGHT_TO_FONTSIZE = 0.8

#: Below this the text is decorative noise from a speckle, and a font size that small makes
#: some viewers drop the glyph entirely.
_MIN_FONTSIZE = 1.0


class SearchablePdfWriter:
    """Overlays recognised text on the original pages as an invisible layer."""

    format: OutputFormat = "searchable-pdf"

    def __init__(self) -> None:
        self._font_path = bundled_font_path()

    def is_available(self) -> bool:
        """PyMuPDF is a hard dependency; only the bundled font could realistically be absent.

        Reported honestly rather than assumed, because a missing font would otherwise fail
        every job that asked for this format instead of greying the option out.
        """
        return self._font_path.is_file()

    def write(self, result: DocumentResult, context: WriteContext) -> list[WrittenFile]:
        target = context.work_dir / "searchable-pdf"
        target.mkdir(parents=True, exist_ok=True)
        output_path = target / f"{context.output_stem}.pdf"

        try:
            with _open_as_pdf(context.source_path) as document:
                self._overlay(document, result)
                # garbage=3 merges the duplicate font objects the overlay creates; deflate
                # keeps a 400 KB scan from growing on account of a few kilobytes of text.
                document.save(str(output_path), garbage=3, deflate=True)
        except OutputWriteError:
            raise
        except Exception as error:
            raise OutputWriteError(f"Could not write the searchable PDF: {error}") from error

        return [measure(output_path, self.format)]

    def _overlay(self, document: pymupdf.Document, result: DocumentResult) -> None:
        font = pymupdf.Font(fontfile=str(self._font_path))

        for page_result in result.pages:
            index = page_result.page_number - 1
            if not 0 <= index < document.page_count:
                # Page caps and text-layer skipping both mean the result can cover fewer
                # pages than the document holds. Never guess at the alignment.
                _logger.warning(
                    "Recognised page has no counterpart in the source document",
                    extra={"pageNumber": page_result.page_number},
                )
                continue

            if page_result.used_existing_text_layer:
                # The page already carries real text, which was reused rather than re-OCRed.
                # Laying our copy on top would duplicate every word in a copy-paste.
                continue

            if not page_result.text_boxes:
                continue

            page = document[index]
            page.insert_font(fontname=_FONT_ALIAS, fontfile=str(self._font_path))
            _write_page_text(page, page_result, font)


def _write_page_text(page: pymupdf.Page, page_result: PageResult, font: pymupdf.Font) -> None:
    """Lay one page's boxes down, scaled from recognition space into PDF points."""
    scale_x, scale_y = _scale_factors(page, page_result)

    for box in page_result.text_boxes:
        text = box.text.strip()
        if not text:
            continue

        width = box.width * scale_x
        height = box.height * scale_y
        if width <= 0 or height <= 0:
            continue

        fontsize = _fit_fontsize(text, font, width, height)
        if fontsize < _MIN_FONTSIZE:
            continue

        # PyMuPDF pages use a top-left origin with y growing downward, and insert_text takes
        # the baseline. `descender` is negative, so adding it lifts the baseline off the box's
        # bottom edge by exactly the depth the descenders will occupy — which keeps "g" and
        # "p" inside the box instead of hanging into the line below.
        baseline_y = box.y1 * scale_y + font.descender * fontsize
        page.insert_text(
            pymupdf.Point(box.x0 * scale_x, baseline_y),
            text,
            fontname=_FONT_ALIAS,
            fontsize=fontsize,
            render_mode=_INVISIBLE_RENDER_MODE,
        )


def _scale_factors(page: pymupdf.Page, page_result: PageResult) -> tuple[float, float]:
    """Recognition coordinates are pixels at the raster DPI; PDF pages are in points.

    A 200 DPI raster of an A4 page is 1654 px across where the PDF is 595 pt, so text boxes
    would land almost three times too far right without this.
    """
    if page_result.width <= 0 or page_result.height <= 0:
        return 1.0, 1.0
    return page.rect.width / page_result.width, page.rect.height / page_result.height


def _fit_fontsize(text: str, font: pymupdf.Font, width: float, height: float) -> float:
    """Largest size that keeps the string inside its own box.

    Width matters more than height: a viewer highlights what the glyphs cover, so a string
    that overruns its box makes selection point at the neighbouring words.
    """
    fontsize = height * _HEIGHT_TO_FONTSIZE
    measured = font.text_length(text, fontsize=fontsize)
    if measured > width and measured > 0:
        fontsize *= width / measured
    return fontsize


def _open_as_pdf(source: Path) -> pymupdf.Document:
    """The source as a PDF document, converting if it is an image.

    A PDF source is opened directly so the user's own pages survive untouched — re-rendering
    them would cost quality and size for nothing. Images become a one-page PDF at the image's
    own pixel size.
    """
    document = pymupdf.open(str(source))
    if document.is_pdf:
        return document

    try:
        pdf_bytes = document.convert_to_pdf()
    finally:
        document.close()
    return pymupdf.open("pdf", pdf_bytes)
