# SPDX-License-Identifier: AGPL-3.0-or-later
"""Page-at-a-time rendering, which is what makes progress and cancellation possible.

Handing PaddleOCR a whole PDF yielded nothing for ten minutes on a five-page scan and held
every page in memory at once. Rendering one page at a time bounds the memory, produces a
result per page, and gives the generator somewhere to stop.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from impressive_ocr_sidecar.core.errors import CorruptDocumentError
from impressive_ocr_sidecar.pipeline.rasterize import (
    MAX_DPI,
    MIN_DPI,
    page_numbers,
    rendered_page,
)


@pytest.fixture
def five_pages(tmp_path: Path) -> Path:
    document = pymupdf.open()
    for number in range(5):
        page = document.new_page(width=595, height=842)
        page.insert_text((60, 90), f"Seite {number + 1}", fontsize=14, fontname="helv")
    target = tmp_path / "five.pdf"
    document.save(target)
    document.close()
    return target


class TestRenderedPage:
    def test_renders_a_page_to_an_image_that_exists(self, five_pages: Path) -> None:
        with rendered_page(five_pages, 1, 150) as image:
            assert image.exists()
            assert image.stat().st_size > 0

    def test_cleans_up_afterwards(self, five_pages: Path) -> None:
        with rendered_page(five_pages, 1, 150) as image:
            captured = image
        # A temp file per page of a 400-page scan is not something to leave to chance.
        assert not captured.exists()

    def test_cleans_up_even_when_the_caller_raises(self, five_pages: Path) -> None:
        captured: Path | None = None
        with pytest.raises(RuntimeError), rendered_page(five_pages, 1, 150) as image:
            captured = image
            raise RuntimeError("inference blew up")

        assert captured is not None and not captured.exists()

    def test_renders_each_page_differently(self, five_pages: Path) -> None:
        with rendered_page(five_pages, 1, 150) as first:
            first_bytes = first.read_bytes()
        with rendered_page(five_pages, 3, 150) as third:
            third_bytes = third.read_bytes()

        # Each page carries its own number, so identical output would mean the page index is
        # being ignored -- which would silently OCR page 1 five times.
        assert first_bytes != third_bytes

    def test_rejects_a_page_that_does_not_exist(self, five_pages: Path) -> None:
        with pytest.raises(CorruptDocumentError), rendered_page(five_pages, 99, 150):
            pass

    def test_rejects_a_file_that_is_not_a_document(self, tmp_path: Path) -> None:
        broken = tmp_path / "not-a.pdf"
        broken.write_bytes(b"certainly not a pdf")

        with pytest.raises(CorruptDocumentError), rendered_page(broken, 1, 150):
            pass

    @pytest.mark.parametrize("dpi", [1, 10_000])
    def test_clamps_an_absurd_dpi_rather_than_exploding(self, five_pages: Path, dpi: int) -> None:
        # A bitmap grows with the square of the DPI; an unbounded value is an out-of-memory
        # error waiting for whoever types an extra zero.
        with rendered_page(five_pages, 1, dpi) as image:
            assert image.exists()

    def test_higher_dpi_produces_a_larger_image(self, five_pages: Path) -> None:
        with rendered_page(five_pages, 1, MIN_DPI) as low:
            low_size = low.stat().st_size
        with rendered_page(five_pages, 1, 300) as high:
            high_size = high.stat().st_size

        assert high_size > low_size
        assert MIN_DPI < MAX_DPI


class TestPageNumbers:
    def test_lists_every_page_when_nothing_is_skipped(self) -> None:
        assert page_numbers(5, frozenset(), 0) == [1, 2, 3, 4, 5]

    def test_leaves_skipped_pages_out_entirely(self) -> None:
        # Excluded here rather than filtered from the results, which is what makes the skip
        # save time instead of hiding work already done.
        assert page_numbers(5, frozenset({2, 4}), 0) == [1, 3, 5]

    def test_applies_the_page_cap_after_skipping(self) -> None:
        assert page_numbers(10, frozenset({1}), 3) == [2, 3, 4]

    def test_treats_a_zero_cap_as_no_cap(self) -> None:
        assert len(page_numbers(40, frozenset(), 0)) == 40

    def test_returns_nothing_when_everything_is_skipped(self) -> None:
        assert page_numbers(3, frozenset({1, 2, 3}), 0) == []
