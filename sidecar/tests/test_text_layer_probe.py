# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

from pathlib import Path

import pytest

from impressive_ocr_sidecar.core.errors import CorruptDocumentError
from impressive_ocr_sidecar.pipeline.text_layer_probe import (
    TextLayerProbe,
    pages_to_skip,
    probe_pdf,
)


class TestProbePdf:
    def test_born_digital_pdf_reports_its_page_as_having_text(self, digital_pdf: Path) -> None:
        probe = probe_pdf(digital_pdf)

        assert probe.page_count == 1
        assert probe.pages_with_text == frozenset({1})
        assert probe.is_fully_digital

    def test_scanned_pdf_reports_no_text_layer(self, scanned_pdf: Path) -> None:
        probe = probe_pdf(scanned_pdf)

        assert probe.page_count == 1
        assert probe.pages_with_text == frozenset()
        assert not probe.has_any_text

    def test_unreadable_file_raises_corrupt_document(self, tmp_path: Path) -> None:
        broken = tmp_path / "broken.pdf"
        broken.write_bytes(b"%PDF-1.7 this is not actually a pdf")

        with pytest.raises(CorruptDocumentError):
            probe_pdf(broken)


class TestPagesToSkip:
    @staticmethod
    def _mixed() -> TextLayerProbe:
        """Three pages where only the middle one is born-digital."""
        return TextLayerProbe(page_count=3, pages_with_text=frozenset({2}))

    def test_always_ocr_never_skips(self) -> None:
        assert pages_to_skip(self._mixed(), "always-ocr") == frozenset()

    def test_hybrid_skips_only_the_pages_that_already_have_text(self) -> None:
        assert pages_to_skip(self._mixed(), "hybrid") == frozenset({2})

    def test_skip_if_text_is_all_or_nothing_on_a_mixed_document(self) -> None:
        # A user who picks "skip if text" means "leave my digital PDFs alone", not
        # "silently OCR two thirds of them".
        assert pages_to_skip(self._mixed(), "skip-if-text") == frozenset()

    def test_skip_if_text_skips_a_fully_digital_document(self) -> None:
        probe = TextLayerProbe(page_count=2, pages_with_text=frozenset({1, 2}))

        assert pages_to_skip(probe, "skip-if-text") == frozenset({1, 2})

    def test_empty_document_is_not_treated_as_fully_digital(self) -> None:
        probe = TextLayerProbe(page_count=0, pages_with_text=frozenset())

        assert not probe.is_fully_digital
        assert pages_to_skip(probe, "skip-if-text") == frozenset()
