# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plain-text output.

PaddleOCR has no ``save_to_txt``, and the obvious shortcut — dumping the Markdown — leaves
pipe tables and heading hashes in a file whose whole point is to have no markup. So this
writer builds the text itself from the recognised strings.
"""

from __future__ import annotations

from pathlib import Path

from ..core.errors import OutputWriteError
from ..core.protocol import OutputFormat
from ..engines.base import DocumentResult
from .base import WriteContext, WrittenFile, measure

#: Separator between pages. A form feed is what `pdftotext` emits and what downstream
#: tooling expects; it survives round-trips that a row of dashes would not.
PAGE_SEPARATOR = "\f"


class TextWriter:
    """Writes one UTF-8 ``.txt`` for the whole document."""

    format: OutputFormat = "txt"

    def __init__(self, encoding: str = "utf-8") -> None:
        self._encoding = encoding

    def is_available(self) -> bool:
        return True

    def write(self, result: DocumentResult, context: WriteContext) -> list[WrittenFile]:
        target = context.work_dir / "txt"
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"{context.output_stem}.txt"

        try:
            path.write_text(render(result), encoding=self._encoding, newline="\n")
        except (OSError, UnicodeEncodeError) as error:
            raise OutputWriteError(f"Could not write {path.name}: {error}") from error

        return [measure(path, self.format)]


def render(result: DocumentResult) -> str:
    """Join every page's text, separated by form feeds.

    Split out so the formatting is testable without touching the filesystem.
    """
    pages = [page.text.strip() for page in result.pages]
    return PAGE_SEPARATOR.join(pages) + "\n" if pages else ""


def resolve_encoding(name: str) -> str:
    """Map a pipeline's ``txtEncoding`` setting onto a Python codec name.

    ``utf-8-bom`` exists because Excel still misreads a plain UTF-8 text file as ANSI on a
    German Windows install, which mangles every umlaut.
    """
    return {"utf-8-bom": "utf-8-sig", "latin-1": "latin-1"}.get(name.lower(), "utf-8")


def default_text_path(work_dir: Path, stem: str) -> Path:
    return work_dir / "txt" / f"{stem}.txt"
