# SPDX-License-Identifier: AGPL-3.0-or-later
"""The chart text has to reach the file the writer actually produces.

This exists because the first version of the fix did not. It appended to
`PageResult.markdown`, every unit test passed, and the `.md` on disk was unchanged -- because
`save_to_markdown` writes the file straight from Paddle's raw result and never reads the
adapter's copy. Only running a chart through the real application showed it: 117 bytes of
Markdown beside 533 bytes of txt from the same job.
"""

from __future__ import annotations

from pathlib import Path

from impressive_ocr_sidecar.engines.base import PageResult, TextBox
from impressive_ocr_sidecar.writers.paddle_native import _restore_chart_text

CHART_RESULT = {"layout_det_res": {"boxes": [{"label": "chart", "coordinate": [0, 0, 500, 400]}]}}
IMAGE_ONLY = '<div><img src="imgs/img_in_chart_box_1.jpg" alt="Image" /></div>'


def page(boxes: list[TextBox], raw: dict | None = None) -> PageResult:
    return PageResult(
        page_number=1,
        width=500.0,
        height=400.0,
        markdown="",
        text="",
        text_boxes=boxes,
        raw=CHART_RESULT if raw is None else raw,
    )


def box(text: str, x0: float, y0: float) -> TextBox:
    return TextBox(text=text, x0=x0, y0=y0, x1=x0 + 30, y1=y0 + 10, confidence=0.99)


class TestRestoreChartText:
    def test_appends_the_labels_to_the_written_file(self, tmp_path: Path) -> None:
        path = tmp_path / "scan_0.md"
        path.write_text(IMAGE_ONLY, encoding="utf-8")

        _restore_chart_text([path], [page([box("Actuate", 10, 20), box("Tableau", 10, 60)])])

        written = path.read_text(encoding="utf-8")
        assert "Actuate" in written
        assert "Tableau" in written
        assert "img_in_chart_box_1.jpg" in written

    def test_leaves_a_page_without_a_chart_alone(self, tmp_path: Path) -> None:
        path = tmp_path / "scan_0.md"
        path.write_text("# Ordinary prose\n", encoding="utf-8")
        prose = {"layout_det_res": {"boxes": [{"label": "text", "coordinate": [0, 0, 10, 10]}]}}

        _restore_chart_text([path], [page([box("x", 1, 1)], raw=prose)])

        assert path.read_text(encoding="utf-8") == "# Ordinary prose\n"

    def test_matches_each_file_to_its_own_page(self, tmp_path: Path) -> None:
        first, second = tmp_path / "scan_0.md", tmp_path / "scan_1.md"
        first.write_text(IMAGE_ONLY, encoding="utf-8")
        second.write_text(IMAGE_ONLY, encoding="utf-8")

        _restore_chart_text(
            [first, second],
            [page([box("FirstPageLabel", 10, 20)]), page([box("SecondPageLabel", 10, 20)])],
        )

        assert "FirstPageLabel" in first.read_text(encoding="utf-8")
        assert "SecondPageLabel" not in first.read_text(encoding="utf-8")
        assert "SecondPageLabel" in second.read_text(encoding="utf-8")

    def test_does_nothing_when_the_counts_disagree(self, tmp_path: Path) -> None:
        # Better to lose the labels than to staple one page's chart onto another page.
        path = tmp_path / "scan_0.md"
        path.write_text(IMAGE_ONLY, encoding="utf-8")

        _restore_chart_text([path], [page([box("A", 1, 1)]), page([box("B", 1, 1)])])

        assert path.read_text(encoding="utf-8") == IMAGE_ONLY

    def test_survives_a_file_it_cannot_read(self, tmp_path: Path) -> None:
        # The document is written and readable; a missing chart label is not worth failing on.
        _restore_chart_text([tmp_path / "gone.md"], [page([box("A", 1, 1)])])
