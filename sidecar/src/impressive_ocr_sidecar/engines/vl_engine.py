# SPDX-License-Identifier: AGPL-3.0-or-later
"""The `accurate` profile: PaddleOCR-VL, a 0.9B vision-language document parser.

Best-in-class on complex tables, formulas and messy scans, and it covers 109 languages
without being told which one to expect.

How it is *driven* matters more than where it runs. PaddleOCR's own backend recognises one
layout region at a time, which costs about a minute on a dense page and needs most of an 8 GB
card. Pointed at a local inference server that batches those regions instead, the identical
weights take ~2 s/page on the same GPU and ~11 s/page on a CPU -- which is why this profile
is no longer GPU-only. See `build_backend_kwargs`.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..core.config import VlServerSettings
from ..core.errors import CorruptDocumentError, DeviceMemoryError, EngineLoadError
from ..core.logging import get_logger
from ..core.protocol import EngineModules, EngineOptions
from .base import PageResult
from .result_adapter import to_page_result

_logger = get_logger()

_OOM_MARKERS = ("out of memory", "cuda error", "cublas", "resource exhausted")


class VlEngine:
    """PaddleOCR-VL wrapper."""

    name = "paddleocr-vl"

    def __init__(
        self,
        device: str,
        modules: EngineModules | None = None,
        *,
        vl_server: VlServerSettings | None = None,
    ) -> None:
        self._device = device
        # Needed before load(), exactly as with PP-StructureV3: the document preprocessor is
        # built in the constructor or not at all.
        self._modules = modules if modules is not None else EngineModules()
        # Where the language model runs. `None` is PaddleOCR's own backend, which decodes one
        # layout region at a time; see `build_backend_kwargs`.
        self._vl_server = vl_server
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
            # The preprocessing toggles belong here, not only on predict().
            #
            # PaddleOCR-VL ships with `use_doc_preprocessor: False`, so its constructor never
            # builds `doc_preprocessor_pipeline`. Asking for orientation or unwarping at
            # predict time then flips the pipeline into using a sub-model that does not
            # exist, and every page dies with "object has no attribute
            # doc_preprocessor_pipeline". Since orientation detection is on by default, that
            # was every document, on every run of this profile.
            self._pipeline = PaddleOCRVL(
                device=self._device,
                use_doc_orientation_classify=self._modules.doc_orientation_classify,
                use_doc_unwarping=self._modules.doc_unwarping,
                **build_backend_kwargs(self._vl_server),
            )
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
            raise _classify(error, f"PaddleOCR-VL could not read the document: {error}") from error

        for index, result in enumerate(results, start=1):
            if index in skip_pages:
                continue
            width, height = _page_size(result)
            yield to_page_result(result, page_number=index, width=width, height=height)


def build_backend_kwargs(vl_server: VlServerSettings | None) -> dict[str, Any]:
    """Map our backend settings onto PaddleOCR's constructor keywords.

    Returns an **empty dict** when no server was configured, so an unconfigured sidecar
    constructs `PaddleOCRVL` exactly as it did before this option existed. Passing
    `vl_rec_backend=None` explicitly would not be equivalent: PaddleOCR validates the value
    against its supported list before deciding whether it was set.

    Why this matters at all: PaddleOCR's own backend pins the language model to a batch size
    of one (`PADDLEOCR_VL_LOCAL_BATCH_SIZE`), so every layout region on a page re-streams the
    full 0.9 B of weights. A server backend receives all of a page's regions as concurrent
    requests instead, which is the whole 28x difference -- the model is identical.
    """
    if vl_server is None:
        return {}

    kwargs: dict[str, Any] = {
        "vl_rec_backend": vl_server.backend,
        "vl_rec_server_url": vl_server.url,
    }
    # Left to PaddleOCR's default (200) when unset, which is far more than any page needs.
    if vl_server.max_concurrency is not None:
        kwargs["vl_rec_max_concurrency"] = vl_server.max_concurrency
    return kwargs


def build_predict_kwargs(options: EngineOptions) -> dict[str, Any]:
    """Map our options onto PaddleOCR-VL's keyword arguments.

    The VLM handles layout, tables and formulas in one pass, so the per-module toggles
    PP-StructureV3 exposes do not apply here.

    The two preprocessing switches are deliberately **not** sent. They are decided in the
    constructor, which is where the sub-models are built, and passing them again could only
    contradict it: a job asking for orientation on a pipeline that was built without it flips
    PaddleOCR-VL into calling a sub-pipeline that was never created. Omitted, the pipeline
    uses what it was constructed with, which is always something that exists.
    """
    kwargs: dict[str, Any] = {}
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
