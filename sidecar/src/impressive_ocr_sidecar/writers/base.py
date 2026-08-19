# SPDX-License-Identifier: AGPL-3.0-or-later
"""The writer contract."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from ..core.protocol import OutputFormat
from ..engines.base import DocumentResult


@dataclass(frozen=True, slots=True)
class WriteContext:
    """Everything a writer needs to produce its file.

    ``work_dir`` is a temp directory owned by the backend. Writers never touch the user's
    output folder: the backend moves finished files there atomically, so a crash mid-write
    can never leave a half-written .docx sitting where a downstream system will pick it up.
    """

    work_dir: Path
    output_stem: str
    source_path: Path


@dataclass(frozen=True, slots=True)
class WrittenFile:
    format: OutputFormat
    path: Path
    bytes: int


@runtime_checkable
class OutputWriter(Protocol):
    """Produces one output format from a finished :class:`DocumentResult`."""

    format: OutputFormat

    def is_available(self) -> bool:
        """False when an optional dependency for this format is missing.

        Checked at startup so the capabilities endpoint can tell the backend which formats
        this build really supports, instead of failing every job that requests one.
        """
        ...

    def write(self, result: DocumentResult, context: WriteContext) -> list[WrittenFile]:
        """Write the format and return the files produced, relative paths resolved."""
        ...


def measure(path: Path, output_format: OutputFormat) -> WrittenFile:
    """Build a :class:`WrittenFile` record for a file already on disk."""
    return WrittenFile(format=output_format, path=path, bytes=path.stat().st_size)
