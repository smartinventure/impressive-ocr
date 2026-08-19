# SPDX-License-Identifier: AGPL-3.0-or-later
"""Writers backed by PaddleOCR's own ``save_to_*`` methods.

Markdown, JSON, DOCX, XLSX, HTML and the visualisation images all come straight out of the
pipeline result. Re-implementing them would mean reproducing Paddle's reading-order and
table-to-HTML logic — significant work, guaranteed to drift from upstream, for no gain.

The only real work here is collecting whatever files Paddle decided to emit: it names them
itself and, for multi-page input, writes one file per page.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..core.errors import OutputWriteError
from ..core.logging import get_logger
from ..core.protocol import OutputFormat
from ..engines.base import DocumentResult
from .base import WriteContext, WrittenFile, measure

_logger = get_logger()

#: Format → the method name on a PaddleOCR page result, and the extensions it produces.
_NATIVE_METHODS: dict[OutputFormat, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "markdown": (("save_to_markdown",), (".md",)),
    "json": (("save_to_json",), (".json",)),
    # PaddleOCR named this save_to_word; older builds expose save_to_docx.
    "docx": (("save_to_word", "save_to_docx"), (".docx",)),
    "xlsx": (("save_to_xlsx",), (".xlsx",)),
    "html": (("save_to_html",), (".html", ".htm")),
    "visualization": (("save_to_img",), (".png", ".jpg", ".jpeg")),
}


class PaddleNativeWriter:
    """Delegates to a ``save_to_*`` method on each page result."""

    def __init__(self, output_format: OutputFormat) -> None:
        if output_format not in _NATIVE_METHODS:
            raise ValueError(f"{output_format} is not produced by PaddleOCR natively")
        self.format: OutputFormat = output_format
        self._method_names, self._extensions = _NATIVE_METHODS[output_format]

    def is_available(self) -> bool:
        """Availability depends on the loaded result objects, which do not exist yet.

        Reported as available and validated per job instead: a missing method degrades to a
        clear per-job error naming the format, rather than a startup failure that would take
        every other format down with it.
        """
        return True

    def write(self, result: DocumentResult, context: WriteContext) -> list[WrittenFile]:
        target = context.work_dir / self.format
        target.mkdir(parents=True, exist_ok=True)

        wrote_anything = False
        for page in result.pages:
            if page.raw is None:
                continue
            method = _resolve_method(page.raw, self._method_names)
            if method is None:
                raise OutputWriteError(
                    f"This PaddleOCR build cannot emit {self.format}: "
                    f"none of {', '.join(self._method_names)} exist on the result object"
                )
            try:
                method(save_path=str(target))
                wrote_anything = True
            except Exception as error:
                raise OutputWriteError(
                    f"PaddleOCR failed to write {self.format} for page {page.page_number}: {error}"
                ) from error

        if not wrote_anything:
            return []

        return self._collect(target)

    def _collect(self, directory: Path) -> list[WrittenFile]:
        """Gather what Paddle wrote. It chooses its own file names, so we glob rather than guess."""
        files = sorted(
            path
            for path in directory.rglob("*")
            if path.is_file() and path.suffix.lower() in self._extensions
        )
        if not files:
            _logger.warning(
                "PaddleOCR reported success but produced no files",
                extra={"format": self.format, "directory": str(directory)},
            )
        return [measure(path, self.format) for path in files]


def _resolve_method(raw_result: Any, candidates: tuple[str, ...]) -> Any:
    """Return the first ``save_to_*`` method the result object actually has."""
    for name in candidates:
        method = getattr(raw_result, name, None)
        if callable(method):
            return method
    return None
