# SPDX-License-Identifier: AGPL-3.0-or-later
"""The `fast` profile: PP-StructureV3 with PP-OCRv6 recognition.

Layout-first: regions are detected and classified, then handed to specialised recognisers.
Runs acceptably on CPU, which is what makes it the fallback whenever no qualifying GPU is
present.
"""

from __future__ import annotations

import platform
import sysconfig
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..core.errors import CorruptDocumentError, EngineLoadError
from ..core.logging import get_logger
from ..core.protocol import EngineModules, EngineOptions
from .base import PageResult
from .result_adapter import to_page_result

_logger = get_logger()


class StructureEngine:
    """PP-StructureV3 wrapper."""

    name = "pp-structure-v3"

    def __init__(self, device: str, modules: EngineModules | None = None) -> None:
        self._device = device
        # The toggles must be known before load(): PP-StructureV3 downloads and instantiates
        # its sub-models in the constructor, so passing them only to predict() is too late.
        self._modules = modules if modules is not None else EngineModules()
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
            # Constructor, not predict(): PP-StructureV3 resolves, downloads and builds every
            # enabled sub-model here. Left at the defaults it pulls formula, chart, seal and
            # table-cell models — hundreds of megabytes, and minutes of load time, for
            # features most pipelines have switched off.
            self._pipeline = PPStructureV3(
                device=self._device,
                enable_mkldnn=_mkldnn_enabled(),
                **build_module_kwargs(self._modules),
            )
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


def use_mkldnn(machine: str, binary_platform: str) -> bool:
    """Whether oneDNN (MKL-DNN) acceleration is safe on this machine.

    PaddleX turns it on by default for CPU inference, and on real x86 hardware it is a large
    win. Under **x64 emulation on an ARM64 host** — a Snapdragon X Windows laptop running the
    x86-64 build — it is not merely slow: inference dies inside
    ``onednn_instruction.cc`` with

        NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute
        not support [pir::ArrayAttribute<pir::DoubleAttribute>]

    and in the full document pipeline it takes the process down with no traceback at all.

    Detection compares the *host* architecture against the architecture the interpreter was
    built for. `platform.machine()` reports the host (ARM64 even under emulation), while
    `sysconfig.get_platform()` reports the binary (win-amd64) — a mismatch means emulation.
    """
    host_is_arm = "arm" in machine.lower() or "aarch64" in machine.lower()
    binary_is_x86 = "amd64" in binary_platform.lower() or "x86_64" in binary_platform.lower()
    return not (host_is_arm and binary_is_x86)


def _mkldnn_enabled() -> bool:
    return use_mkldnn(platform.machine(), sysconfig.get_platform())


def build_module_kwargs(modules: EngineModules) -> dict[str, Any]:
    """Map our module toggles onto PaddleOCR's ``use_*`` keyword arguments.

    Used for **both** the constructor and ``predict()``. The constructor decides which
    sub-models get downloaded and loaded; ``predict()`` decides which run. They have to agree,
    or a pipeline either loads models it never uses or asks for one it never loaded.

    A free function so it can be unit-tested without PaddleOCR installed — this mapping is
    where a typo would silently disable table recognition for everyone.
    """
    return {
        "use_doc_orientation_classify": modules.doc_orientation_classify,
        "use_doc_unwarping": modules.doc_unwarping,
        "use_textline_orientation": modules.textline_orientation,
        "use_table_recognition": modules.table_recognition,
        "use_formula_recognition": modules.formula_recognition,
        "use_chart_recognition": modules.chart_recognition,
        "use_seal_recognition": modules.seal_recognition,
    }


def build_predict_kwargs(options: EngineOptions) -> dict[str, Any]:
    """Keyword arguments for one ``predict()`` call."""
    kwargs = build_module_kwargs(options.modules)
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
