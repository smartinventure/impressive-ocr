# SPDX-License-Identifier: AGPL-3.0-or-later
"""Recovering chart text that PP-StructureV3 leaves out of its Markdown.

The behaviour under test is the one the chart samples exposed: a chart's axis labels and
legend are recognised, reach the txt and searchable-PDF output, and are missing from the
Markdown because the layout block became an image reference.
"""

from __future__ import annotations

from impressive_ocr_sidecar.engines.base import TextBox
from impressive_ocr_sidecar.engines.chart_text import (
    append_chart_text,
    boxes_within,
    chart_regions,
)

PAGE_HEIGHT = 480.0


def result(label: str = "chart", coordinate: tuple[float, ...] = (0, 0, 500, 400)) -> dict:
    return {"layout_det_res": {"boxes": [{"label": label, "coordinate": list(coordinate)}]}}


def box(text: str, x0: float, y0: float) -> TextBox:
    return TextBox(text=text, x0=x0, y0=y0, x1=x0 + 40, y1=y0 + 10, confidence=0.99)


class TestChartRegions:
    def test_finds_a_chart_block(self) -> None:
        assert chart_regions(result()) == [(0.0, 0.0, 500.0, 400.0)]

    def test_covers_figure_and_image_labels(self) -> None:
        # The same suppression applies to those labels, and a chart filed as either would
        # otherwise keep losing its text for a reason the user cannot see.
        assert chart_regions(result("figure")) != []
        assert chart_regions(result("image")) != []

    def test_ignores_ordinary_blocks(self) -> None:
        assert chart_regions(result("paragraph")) == []

    def test_survives_a_result_with_no_layout(self) -> None:
        assert chart_regions({}) == []


class TestBoxesWithin:
    def test_takes_boxes_inside_the_region(self) -> None:
        inside = boxes_within([box("Actuate", 10, 10)], [(0, 0, 500, 400)])
        assert [b.text for b in inside] == ["Actuate"]

    def test_leaves_boxes_outside_it(self) -> None:
        assert boxes_within([box("Footnote", 10, 460)], [(0, 0, 500, 400)]) == []

    def test_keeps_a_label_overhanging_the_frame(self) -> None:
        # Detection boxes routinely overhang the layout block by a pixel or two. Requiring
        # full containment would drop exactly the axis labels that sit against the frame.
        overhanging = TextBox(text="0", x0=-4, y0=395, x1=36, y1=405, confidence=0.9)
        assert boxes_within([overhanging], [(0, 0, 500, 400)]) != []


class TestAppendChartText:
    def test_appends_what_the_markdown_dropped(self) -> None:
        markdown = '<div><img src="imgs/img_in_chart_box_1.jpg" /></div>'
        boxes = [box("Actuate", 10, 20), box("Percentage of Respondents", 10, 300)]

        out = append_chart_text(markdown, result(), boxes, PAGE_HEIGHT)

        assert "Actuate" in out
        assert "Percentage of Respondents" in out
        assert "img_in_chart_box_1.jpg" in out

    def test_orders_top_to_bottom_then_left_to_right(self) -> None:
        boxes = [box("second", 10, 200), box("third", 300, 200), box("first", 10, 20)]

        out = append_chart_text("", result(), boxes, PAGE_HEIGHT)

        assert out.split() == ["first", "second", "third"]

    def test_does_not_repeat_what_the_markdown_already_has(self) -> None:
        # A chart's title is usually outside the plot area and already in the document.
        markdown = "# How BI Customers Use Their Platforms"
        boxes = [box("How BI Customers Use Their Platforms", 10, 5), box("Actuate", 10, 40)]

        out = append_chart_text(markdown, result(), boxes, PAGE_HEIGHT)

        assert out.count("How BI Customers") == 1
        assert "Actuate" in out

    def test_drops_a_repeated_legend_label(self) -> None:
        boxes = [box("Tableau", 10, 20), box("Tableau", 300, 20)]

        assert append_chart_text("", result(), boxes, PAGE_HEIGHT).split() == ["Tableau"]

    def test_leaves_a_page_without_charts_alone(self) -> None:
        markdown = "# A report\n\nOrdinary prose."

        assert append_chart_text(markdown, result("paragraph"), [box("x", 1, 1)], 480.0) == markdown

    def test_is_idempotent(self) -> None:
        # Running twice must not double the block; the second pass sees its own output.
        boxes = [box("Actuate", 10, 20)]
        once = append_chart_text("![chart](c.jpg)", result(), boxes, PAGE_HEIGHT)
        twice = append_chart_text(once, result(), boxes, PAGE_HEIGHT)

        assert once == twice

    def test_returns_markdown_unchanged_when_nothing_was_recognised(self) -> None:
        markdown = "![chart](c.jpg)"

        assert append_chart_text(markdown, result(), [], PAGE_HEIGHT) == markdown


class TestShortLabels:
    """Axis ticks, and why "already in the Markdown" cannot mean the same thing for them.

    Measured on `samples/rendered/charts-p01.png`, suppressing short strings that appear
    anywhere in the body prose dropped `0`, `5` and `10` from an eight-label plot — the whole
    scale of the chart, removed because a sentence elsewhere on the page mentioned a number.
    """

    def test_keeps_an_axis_tick_that_also_appears_in_the_prose(self) -> None:
        markdown = "The experiment ran for 10 seconds at 5 volts."
        boxes = [box("0", 10, 300), box("5", 60, 300), box("10", 110, 300)]

        out = append_chart_text(markdown, result(), boxes, PAGE_HEIGHT)

        assert out.rstrip().endswith("0\n5\n10")

    def test_still_suppresses_a_repeated_title(self) -> None:
        # The case dedup exists for: a full-page chart whose title Paddle put in the document
        # and whose OCR box also falls inside the chart region.
        markdown = "# Revenue by region"
        boxes = [box("Revenue by region", 10, 5), box("Europe", 10, 40)]

        out = append_chart_text(markdown, result(), boxes, PAGE_HEIGHT)

        assert out.count("Revenue by region") == 1

    def test_still_collapses_a_tick_repeated_inside_the_chart(self) -> None:
        # Both axes have an origin; one `0` in the output is enough.
        boxes = [box("0", 10, 300), box("0", 10, 20)]

        assert append_chart_text("", result(), boxes, PAGE_HEIGHT).split() == ["0"]
