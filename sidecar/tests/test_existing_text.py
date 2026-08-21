# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pages that already carry text must contribute it, not vanish.

`hybrid` and `skip-if-text` decide some pages need no OCR. The engine then skipped them and
dropped them: nothing read the text layer the probe had just judged good enough, so a mixed
PDF came out missing every page that was already fine -- while the log claimed to be reusing
it.
"""

from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from impressive_ocr_sidecar.core.errors import CorruptDocumentError
from impressive_ocr_sidecar.pipeline.existing_text import PDF_POINTS_PER_INCH, extract_page


@pytest.fixture
def digital_pdf(tmp_path: Path) -> Path:
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((60, 100), "Rechnung Nr. 4711", fontsize=16, fontname="helv")
    page.insert_text((60, 200), "Gesamtbetrag: 123,50 EUR", fontsize=12, fontname="helv")
    target = tmp_path / "digital.pdf"
    document.save(target)
    document.close()
    return target


class TestExtractPage:
    def test_recovers_the_text_that_is_already_there(self, digital_pdf: Path) -> None:
        page = extract_page(digital_pdf, 1, 200)

        joined = " ".join(box.text for box in page.text_boxes)
        assert "Rechnung Nr. 4711" in joined
        assert "123,50 EUR" in joined

    def test_reports_the_right_page_number(self, digital_pdf: Path) -> None:
        assert extract_page(digital_pdf, 1, 200).page_number == 1

    def test_produces_markdown_so_the_page_reaches_every_writer(self, digital_pdf: Path) -> None:
        # Without this a hybrid run's markdown would silently omit the digital pages.
        assert "Rechnung" in extract_page(digital_pdf, 1, 200).markdown

    def test_scales_coordinates_into_the_raster_space(self, digital_pdf: Path) -> None:
        at_72 = extract_page(digital_pdf, 1, int(PDF_POINTS_PER_INCH))
        at_200 = extract_page(digital_pdf, 1, 200)

        # PyMuPDF measures in points; the OCR path works in raster pixels. Mixing the two
        # would place a searchable PDF's invisible layer at a fraction of the right size.
        ratio = 200 / PDF_POINTS_PER_INCH
        assert at_200.width == pytest.approx(at_72.width * ratio, rel=0.01)
        assert at_200.text_boxes[0].x0 == pytest.approx(at_72.text_boxes[0].x0 * ratio, rel=0.01)

    def test_treats_authored_text_as_certain(self, digital_pdf: Path) -> None:
        # This text was written, not recognised; a model's confidence score would be a lie.
        assert all(box.confidence == 1.0 for box in extract_page(digital_pdf, 1, 200).text_boxes)

    def test_skips_empty_blocks(self, tmp_path: Path) -> None:
        document = pymupdf.open()
        document.new_page(width=595, height=842)
        target = tmp_path / "blank.pdf"
        document.save(target)
        document.close()

        assert extract_page(target, 1, 200).text_boxes == []

    def test_rejects_a_page_that_does_not_exist(self, digital_pdf: Path) -> None:
        with pytest.raises(CorruptDocumentError):
            extract_page(digital_pdf, 99, 200)

    def test_rejects_something_that_is_not_a_pdf(self, tmp_path: Path) -> None:
        broken = tmp_path / "broken.pdf"
        broken.write_bytes(b"not a pdf at all")

        with pytest.raises(CorruptDocumentError):
            extract_page(broken, 1, 200)
