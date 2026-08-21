# SPDX-License-Identifier: AGPL-3.0-or-later
"""The `accurate` profile: PaddleOCR-VL, a 0.9B vision-language document parser.

Best-in-class on complex tables, formulas and messy scans, and it covers 109 languages
without being told which one to expect. It wants roughly 8 GB of VRAM; on CPU a 0.9B VLM
is slow enough to be unusable for bulk work, which is why the backend only ever routes
this profile to a qualifying GPU.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..core.errors import CorruptDocumentError, DeviceMemoryError, EngineLoadError
from ..core.logging import get_logger
from ..core.protocol import EngineOptions
from .base import PageResult
from .result_adapter import to_page_result

_logger = get_logger()

_OOM_MARKERS = ("out of memory", "cuda error", "cublas", "resource exhausted")


class VlEngine:
    """PaddleOCR-VL wrapper."""

    name = "paddleocr-vl"

    def __init__(self, device: str) -> None:
        self._device = device
        self._pipeline: Any = None
        self._version = "unknown"

    def is_loaded(self) -> bool:
        return self._pipeline is not None

    def load(self) -> None:
        if self._pipeline is not None:
            return
        try:
            import paddleocr
            from paddleocr import PaddleOCRVL

            self._version = getattr(paddleocr, "__version__", "unknown")
            self._pipeline = PaddleOCRVL(device=self._device)
        except ImportError as error:
            raise EngineLoadError(
                f"PaddleOCR-VL is unavailable; install paddleocr[doc-parser]: {error}"
            ) from error
        except Exception as error:
            raise _classify(error, f"Failed to load PaddleOCR-VL: {error}") from error

        _logger.info(
            "PaddleOCR-VL loaded",
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

        try:
            results = self._pipeline.predict(str(source), **build_predict_kwargs(options))
        except Exception as error:
            raise _classify(
                error, f"PaddleOCR-VL could not read the document: {error}"
            ) from error

        for index, result in enumerate(results, start=1):
            if index in skip_pages:
                continue
            width, height = _page_size(result)
            yield to_page_result(result, page_number=index, width=width, height=height)


def build_predict_kwargs(options: EngineOptions) -> dict[str, Any]:
    """Map our options onto PaddleOCR-VL's keyword arguments.

    The VLM handles layout, tables and formulas in one pass, so the per-module toggles that
    PP-StructureV3 exposes mostly do not apply here — only the document preprocessing
    switches do.
    """
    modules = options.modules
    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": modules.doc_orientation_classify,
        "use_doc_unwarping": modules.doc_unwarping,
    }
    if options.max_pages_per_document > 0:
        kwargs["page_num"] = options.max_pages_per_document
    return kwargs


def _classify(error: Exception, message: str) -> Exception:
    """Turn a Paddle exception into one of our typed errors.

    Out-of-memory is worth separating: it is transient, so the queue should back off and
    retry rather than quarantine a perfectly good document.
    """
    text = str(error).lower()
    if any(marker in text for marker in _OOM_MARKERS):
        return DeviceMemoryError(message)
    if isinstance(error, EngineLoadError | CorruptDocumentError):
        return error
    return CorruptDocumentError(message)


def _page_size(result: Any) -> tuple[float, float]:
    for attribute in ("input_img", "img", "image"):
        image = getattr(result, attribute, None)
        shape = getattr(image, "shape", None)
        if shape is not None and len(shape) >= 2:
            return (float(shape[1]), float(shape[0]))
    return (1654.0, 2339.0)
