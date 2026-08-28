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
from ..engines.base import DocumentResult, PageResult
from ..engines.chart_text import append_chart_text
from .base import WriteContext, WrittenFile, measure
from .docx_equations import embed_equations
from .page_merge import merge_pages
from .text_layer_fallback import (
    FALLBACK_FORMATS,
    SUFFIXES,
    common_head,
    page_file_name,
    write_page,
)

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

        # Pages with no PaddleOCR result behind them: taken from the PDF's existing text
        # layer, which is the whole point of `hybrid` and means there was no inference to
        # produce a result object. Handled after the loop rather than skipped, which is what
        # left a born-digital PDF with an empty output folder and a successful job.
        from_text_layer = [page for page in result.pages if page.raw is None]
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
            except Exception as error:
                raise OutputWriteError(
                    f"PaddleOCR failed to write {self.format} for page {page.page_number}: {error}"
                ) from error

        # The fallback runs before the empty check, not after it. A document taken entirely
        # from its text layer has no PaddleOCR output at all, so an early return here is
        # exactly the path that produced an empty folder and a successful job.
        paths = self._collect_paths(target)
        if from_text_layer:
            paths = self._write_from_text_layer(from_text_layer, target, paths, context)

        if not paths:
            # Never silently. Reporting success with no file is how this went unnoticed.
            _logger.warning(
                "Nothing was written for this format",
                extra={
                    "format": self.format,
                    "pages": len(result.pages),
                    "fromTextLayer": len(from_text_layer),
                },
            )
            return []

        # Before the merge, while each file still corresponds to one page.
        if self.format == "markdown":
            _restore_chart_text(paths, [page for page in result.pages if page.raw is not None])

        # Pages are recognised one at a time, so Paddle wrote one file per page. A six-page
        # scan asked to produce Word means one Word document, not six.
        files = merge_pages(paths, context.output_stem)

        # After the merge, so each formula is converted once rather than once per page, and
        # so the pass sees the document the user will actually open. `save_to_word` writes
        # its Markdown through verbatim, which leaves a correctly recognised formula sitting
        # in the document as its own LaTeX source.
        if self.format == "docx":
            for path in files:
                embed_equations(path)

        return [measure(path, self.format) for path in files]

    def _write_from_text_layer(
        self,
        pages: list[PageResult],
        target: Path,
        existing: list[Path],
        context: WriteContext,
    ) -> list[Path]:
        """Produce files for the pages PaddleOCR never saw, and re-collect.

        The head of the name is taken from whatever Paddle already wrote, so a mixed document
        -- a digital PDF with scans appended -- interleaves in reading order instead of
        sorting the two sources into separate groups. With no Paddle files at all, which is
        the pure text-layer case, the output stem serves.
        """
        if self.format not in FALLBACK_FORMATS:
            _logger.info(
                "Pages from the existing text layer cannot be written in this format",
                extra={"format": self.format, "pages": len(pages)},
            )
            return existing

        head = common_head(existing) or context.output_stem
        suffix = SUFFIXES[self.format]
        for page in pages:
            path = target / page_file_name(head, page.page_number, suffix)
            try:
                write_page(page, self.format, path)
            except Exception as error:  # noqa: BLE001 - reported, never fatal
                # One page failing must not cost the rest of the document.
                _logger.warning(
                    "Could not write a page taken from the existing text layer",
                    extra={"format": self.format, "page": page.page_number, "error": str(error)},
                )

        return self._collect_paths(target)

    def _collect_paths(self, directory: Path) -> list[Path]:
        """Gather what Paddle wrote. It chooses its own file names, so we glob rather than guess.

        Sorted, and sorted *numerically* where the names end in a page index: Paddle writes
        ``scan_0``, ``scan_1`` … ``scan_10``, which a plain sort puts in the order 0, 1, 10, 2 —
        and a merged document whose pages are shuffled is worse than six separate ones.
        """
        files = sorted(
            (
                path
                for path in directory.rglob("*")
                if path.is_file() and path.suffix.lower() in self._extensions
            ),
            key=_page_order,
        )
        if not files:
            _logger.warning(
                "PaddleOCR reported success but produced no files",
                extra={"format": self.format, "directory": str(directory)},
            )
        return files


def _restore_chart_text(paths: list[Path], pages: list[PageResult]) -> None:
    """Put the chart text back into the Markdown files Paddle just wrote.

    `save_to_markdown` replaces a chart region with an image reference, so the axis labels,
    legend and category names inside it never reach the file — while the same run has them in
    `overall_ocr_res`, and the txt and searchable-PDF writers emit them normally. Measured on
    `samples/charts/`, that was 0-30% of a chart's text in the Markdown against 94-97% in the
    txt from the identical job.

    It has to happen here rather than in the result adapter. `PageResult.markdown` is not what
    this writer emits: Paddle writes the file itself, from the raw result, and never consults
    the adapter's copy. Appending there passed every unit test and changed nothing about the
    document anyone opened.

    Skipped unless the counts line up, because the alternative to knowing which page a file
    belongs to is appending one page's chart labels to another page's text.
    """
    if len(paths) != len(pages):
        _logger.warning(
            "Not restoring chart text: Paddle wrote a different number of files than pages",
            extra={"files": len(paths), "pages": len(pages)},
        )
        return

    for path, page in zip(paths, pages, strict=True):
        try:
            before = path.read_text(encoding="utf-8")
            after = append_chart_text(before, page.raw, page.text_boxes, page.height)
            if after != before:
                path.write_text(after, encoding="utf-8")
        except OSError as error:
            # The document is written and readable; losing a chart's labels is not worth
            # failing the job over.
            _logger.warning(
                "Could not restore chart text into the Markdown",
                extra={"path": str(path), "error": str(error)},
            )


def _page_order(path: Path) -> tuple[str, int, str]:
    """Sort key that reads a trailing page index as a number rather than as text."""
    stem = path.stem
    head, separator, tail = stem.rpartition("_")
    if separator and tail.isdigit():
        return (head, int(tail), stem)
    return (stem, 0, stem)


def _resolve_method(raw_result: Any, candidates: tuple[str, ...]) -> Any:
    """Return the first ``save_to_*`` method the result object actually has."""
    for name in candidates:
        method = getattr(raw_result, name, None)
        if callable(method):
            return method
    return None
