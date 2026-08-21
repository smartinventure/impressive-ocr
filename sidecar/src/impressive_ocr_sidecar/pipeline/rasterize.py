# SPDX-License-Identifier: AGPL-3.0-or-later
"""Turn a document into one image per page, on demand.

Handing PaddleOCR a whole PDF looks convenient and behaves badly. Measured on a five-page
200 DPI scan, CPU, with the model set already warm:

    after engine.load (40s)     1505 MB   threads=20
    ... ten minutes, zero pages yielded ...

`predict()` takes the document, works on all of it, and yields nothing until it is finished.
Three separate problems fall out of that:

* **No progress.** The UI can only say "page 0 of 5" for as long as it runs, because that is
  genuinely all the backend knows.
* **Unbounded memory.** Every page is in flight at once, so the resident set scales with the
  document rather than staying flat. That is what took a 16 GB laptop into swapping.
* **Cancellation does nothing.** There is no point between pages at which to stop, so Cancel
  waits for the whole document.

Rendering page by page and calling the engine once per page fixes all three: memory stays at
one page, each result is yielded the moment it exists, and the generator can simply not
produce the next page when asked to stop.

It also makes skipping real. Pages satisfied by an existing text layer are never rendered at
all, where previously they were OCR'd and then discarded — the skip saved nothing.
"""

from __future__ import annotations

import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ..core.errors import CorruptDocumentError

#: Sensible ceiling on rasterisation. Above this the models gain nothing and the bitmaps grow
#: quadratically; below ~150 small print starts to break down.
MIN_DPI = 72
MAX_DPI = 600


@contextmanager
def rendered_page(source: Path, page_number: int, dpi: int) -> Iterator[Path]:
    """Render one 1-based page to a temporary PNG, and clean it up afterwards.

    A context manager rather than a returned path: the caller is about to hand this to an
    inference call that may fail, and a temp file per page of a 400-page scan is not something
    to leave to chance.
    """
    import pymupdf

    bounded = max(MIN_DPI, min(MAX_DPI, dpi))
    handle = None
    temp_path: Path | None = None

    try:
        document = pymupdf.open(source)
    except Exception as error:
        raise CorruptDocumentError(f"Could not open {source.name}: {error}") from error

    try:
        if page_number < 1 or page_number > document.page_count:
            raise CorruptDocumentError(
                f"{source.name} has {document.page_count} page(s); asked for {page_number}"
            )

        page = document[page_number - 1]
        pixmap = page.get_pixmap(dpi=bounded)

        # delete=False, then unlink in `finally`: Windows will not let another process open a
        # NamedTemporaryFile that is still held here, and PaddleOCR opens it by path.
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - closed in the finally below
            suffix=".png", prefix=f"impressive-ocr-p{page_number}-", delete=False
        )
        temp_path = Path(handle.name)
        handle.close()
        pixmap.save(temp_path)

        yield temp_path
    finally:
        document.close()
        if handle is not None and not handle.closed:
            handle.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def page_numbers(total_pages: int, skip: frozenset[int], limit: int) -> list[int]:
    """The 1-based pages to actually process, in order.

    Skipped pages are excluded here rather than filtered out of the results, which is what
    makes the skip save time instead of merely hiding work already done.
    """
    wanted = [number for number in range(1, total_pages + 1) if number not in skip]
    return wanted[:limit] if limit > 0 else wanted
