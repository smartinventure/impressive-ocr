# SPDX-License-Identifier: AGPL-3.0-or-later
"""Detects pages that already carry an extractable text layer.

Most real corpora are mixed: born-digital invoices sitting next to scans. OCR-ing a page
that already has perfect embedded text is pure waste and usually *worse* than the original,
so `skip-if-text` and `hybrid` let us reuse what is already there.

The threshold work happens here rather than in the engine because it is cheap, has no
PaddleOCR dependency, and is the kind of heuristic that deserves its own tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..core.errors import CorruptDocumentError
from ..core.logging import get_logger
from ..core.protocol import TextLayerStrategy

_logger = get_logger()

#: A page needs at least this many extractable characters to count as "has text".
#: Scans often carry a stray character or two from a stamp or a scanner watermark, so a
#: non-zero floor avoids treating those as a usable text layer.
MIN_CHARS_PER_PAGE = 80

#: ...and the text must cover at least this fraction of the page area. Catches the common
#: case of a scan with only a small born-digital header or page number laid over it.
MIN_TEXT_AREA_RATIO = 0.005


@dataclass(frozen=True, slots=True)
class TextLayerProbe:
    """Which pages of a document already have usable text."""

    page_count: int
    pages_with_text: frozenset[int]
    """1-based page numbers."""

    @property
    def has_any_text(self) -> bool:
        return len(self.pages_with_text) > 0

    @property
    def is_fully_digital(self) -> bool:
        return self.page_count > 0 and len(self.pages_with_text) == self.page_count


def probe_pdf(source: Path) -> TextLayerProbe:
    """Inspect every page of a PDF for an existing text layer.

    Raises :class:`CorruptDocumentError` if the file cannot be opened at all — better to
    fail here, cheaply, than after loading gigabytes of model weights.
    """
    import pymupdf

    pages_with_text: set[int] = set()
    try:
        with pymupdf.open(source) as document:
            page_count = document.page_count
            for index, page in enumerate(document, start=1):
                if _page_has_text_layer(page):
                    pages_with_text.add(index)
    except Exception as error:
        raise CorruptDocumentError(f"Could not open the PDF: {error}") from error

    return TextLayerProbe(page_count=page_count, pages_with_text=frozenset(pages_with_text))


def _page_has_text_layer(page: object) -> bool:
    """True when the page's embedded text is substantial enough to use instead of OCR."""
    get_text = getattr(page, "get_text", None)
    if get_text is None:
        return False

    text = str(get_text("text") or "")
    if len(text.strip()) < MIN_CHARS_PER_PAGE:
        return False

    rect = getattr(page, "rect", None)
    page_area = float(getattr(rect, "width", 0.0)) * float(getattr(rect, "height", 0.0))
    if page_area <= 0:
        return True  # Cannot measure coverage; the character count already passed.

    text_area = 0.0
    for block in get_text("blocks") or []:
        if len(block) >= 4:
            text_area += abs(float(block[2]) - float(block[0])) * abs(
                float(block[3]) - float(block[1])
            )

    return (text_area / page_area) >= MIN_TEXT_AREA_RATIO


def pages_to_skip(probe: TextLayerProbe, strategy: TextLayerStrategy) -> frozenset[int]:
    """Decide which pages the engine may skip under the given strategy.

    ``skip-if-text`` is all-or-nothing per document: a document is either treated as
    born-digital or OCR'd whole. Mixing per page under that name would surprise a user who
    chose it to guarantee "never touch my digital PDFs".
    """
    if strategy == "always-ocr":
        return frozenset()
    if strategy == "skip-if-text":
        return probe.pages_with_text if probe.is_fully_digital else frozenset()
    return probe.pages_with_text  # hybrid
