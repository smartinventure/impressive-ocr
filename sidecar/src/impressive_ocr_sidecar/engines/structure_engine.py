# SPDX-License-Identifier: AGPL-3.0-or-later
"""The `fast` profile: PP-StructureV3 with PP-OCRv6 recognition.

Layout-first: regions are detected and classified, then handed to specialised recognisers.
Runs acceptably on CPU, which is what makes it the fallback whenever no qualifying GPU is
present.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..core.errors import CorruptDocumentError, EngineLoadError
from ..core.logging import get_logger
from ..core.protocol import EngineOptions
from .base import PageResult
from .result_adapter import to_page_result

_logger = get_logger()


class StructureEngine:
    """PP-StructureV3 wrapper."""

    name = "pp-structure-v3"

    def __init__(self, device: str) -> None:
        self._device = device
        self._pipeline: Any = None
        self._version = "unknown"

    def load(self) -> None:
        """Instantiate the pipeline, downloading weights on first run.

        Imported lazily: importing ``paddleocr`` pulls in PaddlePaddle and costs seconds
        plus hundreds of megabytes of RSS, which we do not want in a process that might
        only be answering a health check.
        """
        if self._pipeline is not None:
            return
        try:
            import paddleocr
            from paddleocr import PPStructureV3

            self._version = getattr(paddleocr, "__version__", "unknown")
            self._pipeline = PPStructureV3(device=self._device)
        except ImportError as error:
            raise EngineLoadError(f"PaddleOCR is not installed: {error}") from error
        except Exception as error:
            raise EngineLoadError(f"Failed to load PP-StructureV3: {error}") from error

        _logger.info(
            "PP-StructureV3 loaded",
            extra={"device": self._device, "paddleocrVersion": self._version},
        )

    def version(self) -> str:
        return self._version

    def recognize(
        self,
        source: Path,
        options: EngineOptions,
        *,
        skip_pages: frozenset[int] = frozenset(),
    ) -> Iterator[PageResult]:
        if self._pipeline is None:
            self.load()
        assert self._pipeline is not None

        predict_kwargs = build_predict_kwargs(options)

        try:
            results = self._pipeline.predict(str(source), **predict_kwargs)
        except Exception as error:  # Paddle wraps parse failures in bare Exception
            raise CorruptDocumentError(
                f"PP-StructureV3 could not read the document: {error}"
            ) from error

        for index, result in enumerate(results, start=1):
            if index in skip_pages:
                continue
            width, height = _page_size(result)
            yield to_page_result(result, page_number=index, width=width, height=height)


def build_predict_kwargs(options: EngineOptions) -> dict[str, Any]:
    """Map our option names onto PaddleOCR's ``use_*`` keyword arguments.

    Kept as a free function so it can be unit-tested without PaddleOCR installed — the
    mapping is where a typo would silently disable table recognition for everyone.
    """
    modules = options.modules
    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": modules.doc_orientation_classify,
        "use_doc_unwarping": modules.doc_unwarping,
        "use_textline_orientation": modules.textline_orientation,
        "use_table_recognition": modules.table_recognition,
        "use_formula_recognition": modules.formula_recognition,
        "use_chart_recognition": modules.chart_recognition,
        "use_seal_recognition": modules.seal_recognition,
    }
    if options.max_pages_per_document > 0:
        kwargs["page_num"] = options.max_pages_per_document
    return kwargs


def _page_size(result: Any) -> tuple[float, float]:
    """Best-effort page dimensions; falls back to A4 at 200 DPI."""
    for attribute in ("input_img", "img", "image"):
        image = getattr(result, attribute, None)
        shape = getattr(image, "shape", None)
        if shape is not None and len(shape) >= 2:
            return (float(shape[1]), float(shape[0]))
    return (1654.0, 2339.0)
