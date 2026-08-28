# SPDX-License-Identifier: AGPL-3.0-or-later
"""Output for a document taken from its existing text layer.

The bug: a born-digital PDF run in `hybrid` mode finished with "1 succeeded", a page counter
reading 0 of 8, and an empty output folder. Every page came from the PDF's own text layer, so
none had a PaddleOCR result, and the native writer skipped exactly those pages -- then
returned an empty list without saying anything.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from impressive_ocr_sidecar.engines.base import DocumentResult, PageResult
from impressive_ocr_sidecar.writers.base import WriteContext
from impressive_ocr_sidecar.writers.paddle_native import PaddleNativeWriter
from impressive_ocr_sidecar.writers.text_layer_fallback import common_head, page_file_name


def text_layer_page(number: int, markdown: str) -> PageResult:
    """A page recovered from the PDF's own text, which never reached PaddleOCR."""
    return PageResult(
        page_number=number,
        width=612.0,
        height=792.0,
        markdown=markdown,
        text=markdown,
        text_boxes=[],
        raw=None,
        used_existing_text_layer=True,
    )


@pytest.fixture
def context(tmp_path: Path) -> WriteContext:
    return WriteContext(
        work_dir=tmp_path,
        output_stem="contract",
        source_path=tmp_path / "contract.pdf",
    )


class TestMarkdownFromTextLayer:
    def test_writes_a_file_when_no_page_was_ocred(self, context: WriteContext) -> None:
        result = DocumentResult(
            pages=[text_layer_page(1, "# Contract\n\nFirst page."), text_layer_page(2, "Second.")],
            page_count=2,
        )

        written = PaddleNativeWriter("markdown").write(result, context)

        assert written != []
        content = written[0].path.read_text(encoding="utf-8")
        assert "First page." in content
        assert "Second." in content

    def test_keeps_the_pages_in_order(self, context: WriteContext) -> None:
        result = DocumentResult(
            pages=[text_layer_page(1, "AAA"), text_layer_page(2, "BBB"), text_layer_page(3, "CCC")],
            page_count=3,
        )

        written = PaddleNativeWriter("markdown").write(result, context)
        content = written[0].path.read_text(encoding="utf-8")

        assert content.index("AAA") < content.index("BBB") < content.index("CCC")

    def test_produces_nothing_when_the_text_layer_was_empty(self, context: WriteContext) -> None:
        # A page with no words is not a failure; there is simply nothing to write.
        result = DocumentResult(pages=[text_layer_page(1, "   ")], page_count=1)

        assert PaddleNativeWriter("markdown").write(result, context) == []


class TestWordFromTextLayer:
    def test_writes_a_document(self, context: WriteContext) -> None:
        result = DocumentResult(pages=[text_layer_page(1, "# Title\n\nA paragraph.")], page_count=1)

        written = PaddleNativeWriter("docx").write(result, context)

        assert written != []
        assert written[0].path.suffix == ".docx"
        assert written[0].bytes > 0

    def test_carries_the_text_across(self, context: WriteContext) -> None:
        from docx import Document

        result = DocumentResult(
            pages=[text_layer_page(1, "# Heading\n\nDistinctive sentence.")], page_count=1
        )

        written = PaddleNativeWriter("docx").write(result, context)
        document = Document(str(written[0].path))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)

        assert "Heading" in text
        assert "Distinctive sentence." in text


class TestFormatsThatNeedRecognition:
    def test_reports_nothing_rather_than_inventing_a_spreadsheet(
        self, context: WriteContext
    ) -> None:
        # A text layer has words and boxes, not table structure. Producing an .xlsx from it
        # would mean inventing the part the user actually wanted.
        result = DocumentResult(pages=[text_layer_page(1, "Some text")], page_count=1)

        assert PaddleNativeWriter("xlsx").write(result, context) == []


class TestPageNaming:
    def test_shares_the_head_paddle_used_so_a_mixed_document_interleaves(self) -> None:
        # A digital PDF with scans appended: OCR'd pages and text-layer pages have to sort
        # into one sequence, not two groups.
        existing = [Path("scan_0.md"), Path("scan_2.md")]

        assert common_head(existing) == "scan"
        assert page_file_name("scan", 1, ".md") == "scan_1.md"

    def test_falls_back_to_the_output_stem_when_paddle_wrote_nothing(self) -> None:
        assert common_head([]) is None
