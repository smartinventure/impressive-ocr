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

import math
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

#: Baseline-to-baseline distance as a multiple of the font size.
_LINE_SPACING = 1.2


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
        # Counted so a document that comes out with no selectable text at all says so. It used
        # to be written and reported as a success: a PDF of page images, an empty text layer,
        # and nothing anywhere to suggest the one thing it was asked for had not happened.
        pages_with_text = 0
        pages_needing_text = 0

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

            pages_needing_text += 1
            if not page_result.text_boxes:
                continue

            page = document[index]
            page.insert_font(fontname=_FONT_ALIAS, fontfile=str(self._font_path))
            _write_page_text(page, page_result, font)
            pages_with_text += 1

        if pages_needing_text > 0 and pages_with_text == 0:
            _logger.warning(
                "The searchable PDF has no selectable text: the engine returned no text boxes "
                "for any page",
                extra={"pages": pages_needing_text},
            )
        elif pages_with_text < pages_needing_text:
            _logger.info(
                "Some pages of the searchable PDF have no selectable text",
                extra={"withText": pages_with_text, "expected": pages_needing_text},
            )


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

        for line, fontsize, bottom in _lay_out(text, font, width, height):
            if fontsize < _MIN_FONTSIZE:
                continue

            # PyMuPDF pages use a top-left origin with y growing downward, and insert_text
            # takes the baseline. `descender` is negative, so adding it lifts the baseline off
            # the line's bottom edge by exactly the depth the descenders will occupy — which
            # keeps "g" and "p" inside the line instead of hanging into the next.
            baseline_y = box.y0 * scale_y + bottom + font.descender * fontsize
            page.insert_text(
                pymupdf.Point(box.x0 * scale_x, baseline_y),
                line,
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


def _lay_out(
    text: str, font: pymupdf.Font, width: float, height: float
) -> list[tuple[str, float, float]]:
    """Break one box's text into lines that fit it.

    Each entry is `(line, fontsize, offset of the line's *bottom* from the box's top)`. The
    bottom rather than the top, because the baseline is derived from it and a single-line box
    must land exactly where it did before this existed — at the bottom of its own box.

    A box holding a single recognised line needs none of this and gets one entry back, which
    is every box the fast profile produces.

    PaddleOCR-VL is the reason it exists. Its boxes are whole blocks and their text arrives as
    one unbroken string, so a 563-character paragraph became a single line that had to shrink
    to about a fifth of a point to fit the block's width — below the legibility floor, where
    the writer dropped it. Four fifths of a page's text disappeared that way while the file
    still reported success.

    The size is chosen from the area rather than the height: a paragraph's box is as tall as
    the paragraph, and sizing to that gives one enormous line. `0.5` is a rough average glyph
    width as a fraction of the font size and `_LINE_SPACING` the height of a line, so the
    product estimates how many characters the box can hold; solving for the size that makes
    that equal the text length lands close, and the wrap below uses real metrics from there.
    """
    if not text:
        return []

    fontsize = height * _HEIGHT_TO_FONTSIZE
    single_line = font.text_length(text, fontsize=fontsize)
    if single_line <= width or single_line <= 0:
        return [(text, fontsize, height)]

    estimated = math.sqrt((width * height) / (0.5 * _LINE_SPACING * len(text)))
    # Never larger than one line's worth of the box, which is what a short string in a tall
    # box should still get.
    fontsize = min(estimated, height * _HEIGHT_TO_FONTSIZE)
    if fontsize < _MIN_FONTSIZE:
        return []

    lines = _wrap(text, font, fontsize, width)
    step = fontsize * _LINE_SPACING

    # More lines than the box can hold means the estimate was optimistic; keeping them all
    # would run text past the bottom of the block and over whatever follows it.
    return [
        (line, fontsize, (index + 1) * step)
        for index, line in enumerate(lines)
        if (index + 1) * step <= height
    ]


def _wrap(text: str, font: pymupdf.Font, fontsize: float, width: float) -> list[str]:
    """Greedy word wrap using the font's own measurements."""
    lines: list[str] = []
    current = ""

    for word in text.split():
        candidate = word if current == "" else f"{current} {word}"
        if font.text_length(candidate, fontsize=fontsize) <= width or current == "":
            current = candidate
            continue
        lines.append(current)
        current = word

    if current:
        lines.append(current)
    return lines


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
