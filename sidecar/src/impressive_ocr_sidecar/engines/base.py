# SPDX-License-Identifier: AGPL-3.0-or-later
"""The engine contract every OCR backend implements."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from ..core.protocol import EngineOptions


@dataclass(slots=True)
class PageResult:
    """One recognised page.

    ``raw`` is the untouched PaddleOCR result object. Writers that can use Paddle's own
    ``save_to_*`` methods take it; our own writers (searchable PDF) use ``text_boxes``
    instead. Keeping both means we never re-run inference to produce another format.
    """

    page_number: int
    """1-based."""

    width: float
    """Page width in the coordinate space ``text_boxes`` uses."""

    height: float

    markdown: str = ""
    text: str = ""
    text_boxes: list[TextBox] = field(default_factory=list)
    used_existing_text_layer: bool = False
    raw: Any = None


@dataclass(slots=True)
class TextBox:
    """A recognised text region in page coordinates, origin top-left."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    confidence: float = 1.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass(slots=True)
class DocumentResult:
    """Everything an engine produced for one document."""

    pages: list[PageResult]
    page_count: int

    @property
    def markdown(self) -> str:
        return "\n\n".join(page.markdown for page in self.pages if page.markdown)

    @property
    def text(self) -> str:
        return "\n\n".join(page.text for page in self.pages if page.text)


@runtime_checkable
class OcrEngine(Protocol):
    """An OCR backend.

    Implementations load their models once in :meth:`load` and are then reused for the
    lifetime of the process — model load is the dominant cost, so a per-job engine would
    make the queue an order of magnitude slower.
    """

    name: str

    def load(self) -> None:
        """Load model weights. Called once, before the first job, and may take minutes."""
        ...

    def version(self) -> str:
        """Version string of the underlying model pipeline, for the capabilities endpoint."""
        ...

    def recognize(
        self,
        source: Path,
        options: EngineOptions,
        *,
        skip_pages: frozenset[int] = frozenset(),
    ) -> Iterator[PageResult]:
        """Yield one :class:`PageResult` per page, in order.

        Yielding rather than returning a list is what makes page-level progress possible:
        the caller emits an NDJSON ``page`` message as each result arrives instead of the
        UI sitting at 0% for a 400-page scan.

        ``skip_pages`` holds 1-based page numbers the caller has already satisfied from the
        PDF's existing text layer, so the engine can avoid the work entirely.
        """
        ...
