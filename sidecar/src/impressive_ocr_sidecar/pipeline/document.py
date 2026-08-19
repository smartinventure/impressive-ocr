# SPDX-License-Identifier: AGPL-3.0-or-later
"""Input inspection that must happen before any model is loaded."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..core.errors import CorruptDocumentError, UnsupportedInputError

PDF_SUFFIXES = frozenset({".pdf"})
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".bmp", ".webp"})
#: Multi-page TIFF is supported; PaddleOCR reads it directly.
TIFF_SUFFIXES = frozenset({".tif", ".tiff"})

SUPPORTED_SUFFIXES = PDF_SUFFIXES | IMAGE_SUFFIXES | TIFF_SUFFIXES


@dataclass(frozen=True, slots=True)
class DocumentInfo:
    path: Path
    kind: str
    """One of ``pdf``, ``image``, ``tiff``."""

    page_count: int

    @property
    def is_pdf(self) -> bool:
        return self.kind == "pdf"


def inspect(source: Path) -> DocumentInfo:
    """Identify the input and count its pages.

    Runs before the engine is touched so an unsupported or corrupt file fails in
    milliseconds instead of after a minute of model loading.
    """
    if not source.is_file():
        raise CorruptDocumentError(f"Input is not a readable file: {source}")

    suffix = source.suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise UnsupportedInputError(
            f"Unsupported file type {suffix or '(none)'}; "
            f"expected one of {', '.join(sorted(SUPPORTED_SUFFIXES))}"
        )

    if suffix in PDF_SUFFIXES:
        return DocumentInfo(path=source, kind="pdf", page_count=_pdf_page_count(source))
    if suffix in TIFF_SUFFIXES:
        return DocumentInfo(path=source, kind="tiff", page_count=_tiff_page_count(source))
    return DocumentInfo(path=source, kind="image", page_count=1)


def _pdf_page_count(source: Path) -> int:
    import pymupdf

    try:
        with pymupdf.open(source) as document:
            return int(document.page_count)
    except Exception as error:
        raise CorruptDocumentError(f"Could not read the PDF: {error}") from error


def _tiff_page_count(source: Path) -> int:
    import pymupdf

    try:
        with pymupdf.open(source) as document:
            return int(document.page_count)
    except Exception:  # noqa: BLE001 - PyMuPDF cannot open every TIFF flavour
        # Not fatal: PaddleOCR reads TIFFs PyMuPDF rejects. Report one page and let the
        # engine's own page stream correct the count.
        return 1


def effective_page_count(info: DocumentInfo, max_pages: int) -> int:
    """Apply the pipeline's per-document page cap."""
    if max_pages <= 0:
        return info.page_count
    return min(info.page_count, max_pages)
