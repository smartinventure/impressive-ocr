# SPDX-License-Identifier: AGPL-3.0-or-later
"""The adapter must read both PaddleOCR result shapes.

Regression cover for a silent failure found by running the real engine on a scanned invoice:
PP-StructureV3 completed normally and reported **zero** text regions, because it nests the
page-wide OCR arrays under ``overall_ocr_res`` while the plain OCR pipeline puts them at the
top level. Nothing raised — the page simply came back empty.
"""

from __future__ import annotations

from typing import Any

from impressive_ocr_sidecar.engines.result_adapter import extract_text_boxes

#: Two lines with square boxes, in the arrays Paddle actually returns.
_TEXTS = ["Rechnung Nr. 4711", "Gesamtbetrag: 123,50 EUR"]
_POLYS = [
    [[60.0, 90.0], [300.0, 90.0], [300.0, 118.0], [60.0, 118.0]],
    [[60.0, 300.0], [340.0, 300.0], [340.0, 330.0], [60.0, 330.0]],
]
_SCORES = [0.997, 0.981]


class _Result:
    """Stand-in for a Paddle result object, which exposes its payload as ``.json``."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.json = payload


def _flat_payload() -> dict[str, Any]:
    return {
        "rec_texts": list(_TEXTS),
        "rec_polys": [list(p) for p in _POLYS],
        "rec_scores": list(_SCORES),
    }


class TestExtractTextBoxes:
    def test_reads_the_flat_paddleocr_shape(self) -> None:
        boxes = extract_text_boxes(_Result({"res": _flat_payload()}))
        assert [box.text for box in boxes] == _TEXTS

    def test_reads_the_nested_structure_shape(self) -> None:
        # PP-StructureV3: layout blocks at the top level, OCR arrays one level down.
        payload = {
            "res": {
                "parsing_res_list": [{"block_label": "text"}],
                "overall_ocr_res": _flat_payload(),
            }
        }
        boxes = extract_text_boxes(_Result(payload))
        assert [box.text for box in boxes] == _TEXTS, "structure results must not come back empty"

    def test_carries_boxes_and_confidence_through_the_nested_shape(self) -> None:
        payload = {"res": {"overall_ocr_res": _flat_payload()}}
        first = extract_text_boxes(_Result(payload))[0]
        assert (first.x0, first.y0, first.x1, first.y1) == (60.0, 90.0, 300.0, 118.0)
        assert first.confidence == _SCORES[0]

    def test_prefers_the_top_level_when_both_levels_carry_text(self) -> None:
        # Defensive: if a future version populates both, the outer one is the page result.
        payload = {
            "res": {
                **_flat_payload(),
                "overall_ocr_res": {
                    "rec_texts": ["stale"],
                    "rec_polys": [_POLYS[0]],
                    "rec_scores": [0.5],
                },
            }
        }
        assert [box.text for box in extract_text_boxes(_Result(payload))] == _TEXTS

    def test_unrecognised_shape_yields_no_boxes(self) -> None:
        assert extract_text_boxes(_Result({"res": {"parsing_res_list": []}})) == []
        assert extract_text_boxes(object()) == []
