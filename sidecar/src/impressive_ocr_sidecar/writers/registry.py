# SPDX-License-Identifier: AGPL-3.0-or-later
"""Maps requested output formats onto writers."""

from __future__ import annotations

from ..core.protocol import OutputFormat
from .base import OutputWriter
from .paddle_native import PaddleNativeWriter
from .text_writer import TextWriter

#: Formats this build can emit. `searchable-pdf` is intentionally absent until its writer
#: lands (milestone 2); the capabilities endpoint reports this list so the backend can grey
#: the option out in the UI rather than accepting a job it cannot finish.
SUPPORTED_FORMATS: tuple[OutputFormat, ...] = (
    "markdown",
    "json",
    "txt",
    "docx",
    "xlsx",
    "html",
    "visualization",
)

_PADDLE_NATIVE: frozenset[OutputFormat] = frozenset(
    {"markdown", "json", "docx", "xlsx", "html", "visualization"}
)


class UnsupportedFormatError(ValueError):
    """A format was requested that this build cannot produce."""


def create_writer(output_format: OutputFormat, *, txt_encoding: str = "utf-8") -> OutputWriter:
    """Build the writer for one format."""
    if output_format == "txt":
        return TextWriter(encoding=txt_encoding)
    if output_format in _PADDLE_NATIVE:
        return PaddleNativeWriter(output_format)
    raise UnsupportedFormatError(
        f"{output_format} is not supported by this build; "
        f"supported formats are {', '.join(SUPPORTED_FORMATS)}"
    )


def create_writers(
    formats: list[OutputFormat], *, txt_encoding: str = "utf-8"
) -> list[OutputWriter]:
    """Build every requested writer up front.

    Constructing them all before the first one runs means an unsupported format fails the
    job immediately, instead of after the expensive formats have already been written.
    """
    return [create_writer(item, txt_encoding=txt_encoding) for item in dict.fromkeys(formats)]
