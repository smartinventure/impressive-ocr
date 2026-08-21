# SPDX-License-Identifier: AGPL-3.0-or-later
"""The searchable PDF writer.

Asserted through PyMuPDF's own text extraction rather than by inspecting the file: what
matters is that a reader can select and search the words, and at the right place on the page.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from impressive_ocr_sidecar.engines.base import DocumentResult, PageResult, TextBox
from impressive_ocr_sidecar.writers.base import WriteContext
from impressive_ocr_sidecar.writers.searchable_pdf import SearchablePdfWriter

A4_WIDTH_PT = 595.0
A4_HEIGHT_PT = 842.0

#: A 200 DPI raster of an A4 page, which is the coordinate space the boxes come in.
RASTER_WIDTH = 1654.0
RASTER_HEIGHT = 2339.0


@pytest.fixture
def source_pdf(tmp_path: Path) -> Path:
    """A one-page PDF with a visible word on it, standing in for a scan."""
    path = tmp_path / "scan.pdf"
    document = pymupdf.open()
    page = document.new_page(width=A4_WIDTH_PT, height=A4_HEIGHT_PT)
    page.draw_rect(pymupdf.Rect(100, 100, 300, 140), color=(0, 0, 0))
    document.save(str(path))
    document.close()
    return path


def _result(boxes: list[TextBox], *, used_existing: bool = False) -> DocumentResult:
    return DocumentResult(
        pages=[
            PageResult(
                page_number=1,
                width=RASTER_WIDTH,
                height=RASTER_HEIGHT,
                text_boxes=boxes,
                used_existing_text_layer=used_existing,
            )
        ],
        page_count=1,
    )


def _context(tmp_path: Path, source: Path) -> WriteContext:
    return WriteContext(work_dir=tmp_path, output_stem="scan", source_path=source)


def test_text_is_searchable_in_the_written_pdf(tmp_path: Path, source_pdf: Path) -> None:
    boxes = [TextBox(text="Rechnung", x0=278, y0=278, x1=834, y1=389)]

    written = SearchablePdfWriter().write(_result(boxes), _context(tmp_path, source_pdf))

    assert len(written) == 1
    with pymupdf.open(str(written[0].path)) as document:
        assert document.page_count == 1
        assert "Rechnung" in document[0].get_text()
        assert document[0].search_for("Rechnung"), "the word must be findable by a reader"


def test_text_lands_where_the_ink_is(tmp_path: Path, source_pdf: Path) -> None:
    """A box a third of the way down the raster must land a third of the way down the page.

    Recognition coordinates are pixels at the raster DPI and the page is in points, so an
    unscaled overlay would put this text far off the right-hand edge.
    """
    boxes = [TextBox(text="Rechnung", x0=278, y0=780, x1=834, y1=880)]

    written = SearchablePdfWriter().write(_result(boxes), _context(tmp_path, source_pdf))

    with pymupdf.open(str(written[0].path)) as document:
        (found,) = document[0].search_for("Rechnung")
        assert found.x0 == pytest.approx(278 * A4_WIDTH_PT / RASTER_WIDTH, abs=4)
        assert found.y1 == pytest.approx(880 * A4_HEIGHT_PT / RASTER_HEIGHT, abs=6)


def test_the_original_page_is_left_alone(tmp_path: Path, source_pdf: Path) -> None:
    """The scan is the product; the text is an addition to it, not a re-rendering."""
    boxes = [TextBox(text="Rechnung", x0=278, y0=278, x1=834, y1=389)]

    written = SearchablePdfWriter().write(_result(boxes), _context(tmp_path, source_pdf))

    with pymupdf.open(str(written[0].path)) as document:
        page = document[0]
        assert page.rect.width == pytest.approx(A4_WIDTH_PT)
        assert page.rect.height == pytest.approx(A4_HEIGHT_PT)
        # The rectangle drawn into the source is still drawn.
        assert page.get_drawings(), "the original page content must survive"


def test_a_reused_text_layer_is_not_duplicated(tmp_path: Path, source_pdf: Path) -> None:
    """Pages whose existing text was reused already carry it; adding ours doubles every word."""
    boxes = [TextBox(text="Rechnung", x0=278, y0=278, x1=834, y1=389)]

    written = SearchablePdfWriter().write(
        _result(boxes, used_existing=True), _context(tmp_path, source_pdf)
    )

    with pymupdf.open(str(written[0].path)) as document:
        assert "Rechnung" not in document[0].get_text()


def test_an_image_source_becomes_a_one_page_pdf(tmp_path: Path) -> None:
    image = tmp_path / "scan.png"
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 800, 1000))
    pixmap.clear_with(255)
    pixmap.save(str(image))

    result = DocumentResult(
        pages=[
            PageResult(
                page_number=1,
                width=800,
                height=1000,
                text_boxes=[TextBox(text="Quittung", x0=40, y0=40, x1=300, y1=90)],
            )
        ],
        page_count=1,
    )

    written = SearchablePdfWriter().write(result, _context(tmp_path, image))

    with pymupdf.open(str(written[0].path)) as document:
        assert document.page_count == 1
        assert "Quittung" in document[0].get_text()


def test_empty_and_degenerate_boxes_are_skipped(tmp_path: Path, source_pdf: Path) -> None:
    """A speckle can produce a zero-height box; a font size of zero throws in some viewers."""
    boxes = [
        TextBox(text="   ", x0=10, y0=10, x1=200, y1=60),
        TextBox(text="Ignored", x0=10, y0=10, x1=10, y1=10),
        TextBox(text="Kept", x0=278, y0=278, x1=834, y1=389),
    ]

    written = SearchablePdfWriter().write(_result(boxes), _context(tmp_path, source_pdf))

    with pymupdf.open(str(written[0].path)) as document:
        text = document[0].get_text()
    assert "Kept" in text
    assert "Ignored" not in text


def test_a_page_the_document_does_not_have_is_ignored(tmp_path: Path, source_pdf: Path) -> None:
    """Page caps mean the result can name a page the source PDF does not contain."""
    result = DocumentResult(
        pages=[
            PageResult(
                page_number=9,
                width=RASTER_WIDTH,
                height=RASTER_HEIGHT,
                text_boxes=[TextBox(text="Rechnung", x0=10, y0=10, x1=200, y1=60)],
            )
        ],
        page_count=9,
    )

    written = SearchablePdfWriter().write(result, _context(tmp_path, source_pdf))

    assert len(written) == 1
