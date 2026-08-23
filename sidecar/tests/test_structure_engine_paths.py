# SPDX-License-Identifier: AGPL-3.0-or-later
"""Which input the engine actually hands to PaddleOCR.

A one-page PDF used to be passed straight through, on the reasoning that rendering it would
only add a copy. Measured on a 200 DPI A4 scan, that was the worse choice in two ways: Paddle
rasterises at a resolution of its own, so the user's raster DPI was silently ignored, and the
recognised text lost word spacing that rendering the same page ourselves preserved —

    "the newmodel turning on of theA3high-speed"   Paddle's own rendering
    "the new model turning on of the A3 high-speed"   ours, same page

Images still go straight through: they are already pixels.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf
import pytest

from impressive_ocr_sidecar.core.protocol import EngineOptions
from impressive_ocr_sidecar.engines.structure_engine import StructureEngine


class StubPipeline:
    """Records what it was asked to predict and returns one featureless page.

    The width is measured here, inside the call: a rendered page lives in a context manager
    and is deleted the moment the engine moves on, so there is nothing to open afterwards.
    """

    def __init__(self) -> None:
        self.seen: list[str] = []
        self.widths: list[int] = []

    def predict(self, source: str, **_kwargs: Any) -> list[Any]:
        self.seen.append(source)
        # Pixmap, not open(): a Document reports an image's size in points, which stays 595
        # whatever resolution the page was rendered at.
        self.widths.append(pymupdf.Pixmap(source).width)
        return [object()]


@pytest.fixture
def one_page_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "scan.pdf"
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text(pymupdf.Point(72, 144), "New customer's development")
    document.save(str(path))
    document.close()
    return path


@pytest.fixture
def image(tmp_path: Path) -> Path:
    path = tmp_path / "scan.png"
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 400, 500))
    pixmap.clear_with(255)
    pixmap.save(str(path))
    return path


def _engine() -> tuple[StructureEngine, StubPipeline]:
    engine = StructureEngine(device="cpu")
    pipeline = StubPipeline()
    # Injected rather than loaded: the point of the test is the routing decision, and loading
    # the real pipeline would need PaddlePaddle and several gigabytes of weights.
    engine._pipeline = pipeline
    return engine, pipeline


def test_a_one_page_pdf_is_rendered_rather_than_handed_over(one_page_pdf: Path) -> None:
    engine, pipeline = _engine()

    list(engine.recognize(one_page_pdf, EngineOptions(rasterDpi=300)))

    assert len(pipeline.seen) == 1
    handed_over = Path(pipeline.seen[0])
    assert handed_over.suffix.lower() != ".pdf", "the PDF itself must not reach PaddleOCR"
    assert handed_over.suffix.lower() in {".png", ".jpg", ".jpeg"}


def test_the_rendering_honours_the_requested_dpi(one_page_pdf: Path) -> None:
    """The setting exists in the UI; on this path it used to do nothing at all."""
    sizes: dict[int, int] = {}

    for dpi in (150, 400):
        engine, pipeline = _engine()
        list(engine.recognize(one_page_pdf, EngineOptions(rasterDpi=dpi)))
        sizes[dpi] = pipeline.widths[0]

    # 400/150 is a factor of 2.7; anything near 1 would mean the setting was ignored again.
    assert sizes[400] > sizes[150] * 2


def test_an_image_is_passed_through_untouched(image: Path) -> None:
    engine, pipeline = _engine()

    list(engine.recognize(image, EngineOptions(rasterDpi=300)))

    assert pipeline.seen == [str(image)]


class TestPinnedModels:
    """The recognition model must stay pinned.

    Left unset, PP-StructureV3 picks its own default — PP-OCRv5_server_rec, which mangles
    German diacritics ("groB" for "groß", "bestatigen" for "bestätigen") and loses word
    boundaries on English. That is exactly what this codebase shipped while its docstring
    claimed PP-OCRv6, because nothing pinned the choice and nothing checked it.
    """

    def test_the_models_are_the_measured_v6_pair(self) -> None:
        from impressive_ocr_sidecar.engines import structure_engine

        assert structure_engine._TEXT_RECOGNITION_MODEL == "PP-OCRv6_medium_rec"
        assert structure_engine._TEXT_DETECTION_MODEL == "PP-OCRv6_medium_det"
