# SPDX-License-Identifier: AGPL-3.0-or-later
"""Text boxes from a PaddleOCR-VL result.

The bug this closes: a searchable PDF produced on the accurate profile contained the page
images and an empty text layer -- 0 characters, 0 word boxes -- while the same run wrote
several thousand characters of correct text to Markdown and Word. PaddleOCR-VL has no
detection stage, so it carries none of the `rec_texts`/`rec_polys` the adapter looked for, and
nothing read the `parsing_res_list` it does carry.
"""

from __future__ import annotations

from impressive_ocr_sidecar.engines.result_adapter import extract_text_boxes
from impressive_ocr_sidecar.engines.vl_boxes import extract_vl_boxes


class _Result:
    """Stands in for a PaddleOCRVLResult, which exposes its payload as `.json`."""

    def __init__(self, payload: dict) -> None:
        self.json = payload


def block(content: str, bbox: list[float], label: str = "text") -> dict:
    return {"block_content": content, "block_bbox": bbox, "block_label": label}


class TestExtractVlBoxes:
    def test_reads_a_block_into_a_box(self) -> None:
        boxes = extract_vl_boxes({"parsing_res_list": [block("Hello", [10, 20, 110, 40])]})

        assert len(boxes) == 1
        assert boxes[0].text == "Hello"
        assert (boxes[0].x0, boxes[0].y0, boxes[0].x1, boxes[0].y1) == (10, 20, 110, 40)

    def test_splits_a_paragraph_across_its_height(self) -> None:
        # One box for the whole block would stretch the text as a single line over the
        # paragraph, so a search hit would highlight all of it and the invisible words would
        # sit nowhere near the printed ones.
        boxes = extract_vl_boxes(
            {"parsing_res_list": [block("first\nsecond\nthird", [0, 0, 100, 30])]}
        )

        assert [box.text for box in boxes] == ["first", "second", "third"]
        assert [(box.y0, box.y1) for box in boxes] == [(0, 10), (10, 20), (20, 30)]

    def test_ignores_blank_lines_inside_a_block(self) -> None:
        boxes = extract_vl_boxes({"parsing_res_list": [block("a\n\n\nb", [0, 0, 10, 20])]})

        assert [box.text for box in boxes] == ["a", "b"]

    def test_skips_blocks_that_are_not_text(self) -> None:
        # A figure's content is a path or nothing, and invisible text laid across a photograph
        # is selectable nonsense sitting on top of it.
        payload = {
            "parsing_res_list": [
                block("imgs/img_1.jpg", [0, 0, 100, 100], label="image"),
                block("A caption", [0, 100, 100, 120]),
            ]
        }

        assert [box.text for box in extract_vl_boxes(payload)] == ["A caption"]

    def test_skips_a_block_with_no_content(self) -> None:
        payload = {
            "parsing_res_list": [block("   ", [0, 0, 10, 10]), block("real", [0, 10, 10, 20])]
        }

        assert [box.text for box in extract_vl_boxes(payload)] == ["real"]

    def test_ignores_a_malformed_or_inverted_bbox(self) -> None:
        # A zero-height box would divide by nothing and produce text with no place to sit.
        payload = {
            "parsing_res_list": [
                block("bad", [0, 10, 10, 10]),
                block("short", [1, 2, 3]),
                block("good", [0, 0, 10, 10]),
            ]
        }

        assert [box.text for box in extract_vl_boxes(payload)] == ["good"]

    def test_is_empty_for_a_result_that_is_not_vl_shaped(self) -> None:
        assert extract_vl_boxes({"overall_ocr_res": {"rec_texts": ["x"]}}) == []


class TestAdapterFallsBackToVl:
    def test_a_vl_result_now_yields_boxes(self) -> None:
        # The end of the chain: this returning [] is what left the PDF empty.
        result = _Result({"res": {"parsing_res_list": [block("Recognised", [0, 0, 50, 20])]}})

        boxes = extract_text_boxes(result)

        assert [box.text for box in boxes] == ["Recognised"]

    def test_the_structure_shape_still_wins(self) -> None:
        # A result carrying both must use the detector's boxes: they are per line, and the
        # blocks would be a coarser duplicate of the same words.
        result = _Result(
            {
                "res": {
                    "overall_ocr_res": {"rec_texts": ["detected"], "rec_polys": [[[0, 0], [9, 9]]]},
                    "parsing_res_list": [block("blocked", [0, 0, 50, 20])],
                }
            }
        )

        assert [box.text for box in extract_text_boxes(result)] == ["detected"]
