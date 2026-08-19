# SPDX-License-Identifier: AGPL-3.0-or-later
from __future__ import annotations

from pathlib import Path

import pytest

from impressive_ocr_sidecar.core.errors import CorruptDocumentError, UnsupportedInputError
from impressive_ocr_sidecar.pipeline import document


class TestInspect:
    def test_identifies_a_pdf_and_counts_its_pages(self, digital_pdf: Path) -> None:
        info = document.inspect(digital_pdf)

        assert info.kind == "pdf"
        assert info.is_pdf
        assert info.page_count == 1

    def test_treats_a_single_image_as_one_page(self, tmp_path: Path) -> None:
        image = tmp_path / "scan.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n")

        info = document.inspect(image)

        assert info.kind == "image"
        assert info.page_count == 1

    def test_rejects_an_unsupported_extension(self, tmp_path: Path) -> None:
        path = tmp_path / "notes.docx"
        path.write_bytes(b"PK\x03\x04")

        with pytest.raises(UnsupportedInputError):
            document.inspect(path)

    def test_rejects_a_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(CorruptDocumentError):
            document.inspect(tmp_path / "absent.pdf")

    def test_rejects_a_directory(self, tmp_path: Path) -> None:
        directory = tmp_path / "folder.pdf"
        directory.mkdir()

        with pytest.raises(CorruptDocumentError):
            document.inspect(directory)


class TestEffectivePageCount:
    @staticmethod
    def _info(pages: int) -> document.DocumentInfo:
        return document.DocumentInfo(path=Path("x.pdf"), kind="pdf", page_count=pages)

    def test_zero_means_no_limit(self) -> None:
        assert document.effective_page_count(self._info(500), 0) == 500

    def test_caps_a_long_document(self) -> None:
        assert document.effective_page_count(self._info(500), 50) == 50

    def test_does_not_inflate_a_short_document(self) -> None:
        assert document.effective_page_count(self._info(3), 50) == 3
