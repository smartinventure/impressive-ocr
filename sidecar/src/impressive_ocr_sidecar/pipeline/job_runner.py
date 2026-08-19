# SPDX-License-Identifier: AGPL-3.0-or-later
"""Runs one document end to end and yields NDJSON messages as it goes.

This is the only place that knows the whole job shape: inspect → probe → recognise →
write. It is a generator so the backend sees each page land in real time; a 400-page scan
that reported nothing until it finished would be indistinguishable from a hang.
"""

from __future__ import annotations

import time
from collections.abc import Generator, Iterator
from pathlib import Path

from ..core.errors import SidecarError
from ..core.logging import get_logger
from ..core.protocol import (
    AcceptedMessage,
    DoneMessage,
    ErrorMessage,
    JobRequest,
    LogMessage,
    OutputMessage,
    PageMessage,
    SidecarMessage,
)
from ..engines.base import DocumentResult, OcrEngine
from ..writers.base import OutputWriter, WriteContext
from ..writers.registry import UnsupportedFormatError, create_writers
from . import document
from .text_layer_probe import TextLayerProbe, pages_to_skip, probe_pdf

_logger = get_logger()


def run_job(
    request: JobRequest, engine: OcrEngine
) -> Generator[SidecarMessage, None, None]:
    """Process one document, yielding progress messages.

    Never raises: every failure becomes an :class:`ErrorMessage` carrying a retry decision,
    because an exception escaping here would break the NDJSON stream and leave the backend
    guessing whether the job is retryable.

    Returns a ``Generator`` rather than a plain ``Iterator`` so the caller can ``close()``
    it when the backend disconnects mid-document.
    """
    started = time.monotonic()
    try:
        yield from _run(request, engine, started)
    except SidecarError as error:
        _logger.error(
            "Job failed",
            extra={"jobId": request.job_id, "code": error.code},
            exc_info=error,
        )
        yield ErrorMessage(
            job_id=request.job_id,
            code=error.code,
            message=error.message,
            retryable=error.retryable,
        )
    except Exception as error:
        _logger.error("Unexpected job failure", extra={"jobId": request.job_id}, exc_info=error)
        yield ErrorMessage(
            job_id=request.job_id,
            code="internal-error",
            message=str(error),
            retryable=True,
        )


def _run(request: JobRequest, engine: OcrEngine, started: float) -> Iterator[SidecarMessage]:
    source = Path(request.source_path)
    info = document.inspect(source)
    page_cap = document.effective_page_count(info, request.engine.max_pages_per_document)

    # Build writers before any inference: an unsupported format should cost milliseconds,
    # not a full document's processing time.
    try:
        writers = create_writers(request.formats)
    except UnsupportedFormatError as error:
        raise SidecarError(str(error)) from error

    skip_pages, probe = _resolve_skip_pages(request, info)
    if skip_pages:
        yield LogMessage(
            job_id=request.job_id,
            level="info",
            message=(
                f"Reusing the existing text layer on {len(skip_pages)} of "
                f"{probe.page_count if probe else page_cap} pages"
            ),
        )

    yield AcceptedMessage(job_id=request.job_id, page_count=page_cap)

    pages = []
    page_started = time.monotonic()
    for page in engine.recognize(source, request.engine, skip_pages=skip_pages):
        if page_cap and page.page_number > page_cap:
            break
        pages.append(page)
        now = time.monotonic()
        yield PageMessage(
            job_id=request.job_id,
            page=page.page_number,
            page_count=page_cap,
            used_existing_text_layer=page.used_existing_text_layer,
            elapsed_ms=(now - page_started) * 1000.0,
        )
        page_started = now

    result = DocumentResult(pages=pages, page_count=page_cap or len(pages))
    yield from _write_outputs(request, result, writers)

    yield DoneMessage(
        job_id=request.job_id,
        page_count=result.page_count,
        duration_ms=(time.monotonic() - started) * 1000.0,
    )


def _resolve_skip_pages(
    request: JobRequest, info: document.DocumentInfo
) -> tuple[frozenset[int], TextLayerProbe | None]:
    """Probe for an existing text layer, but only when it can change the outcome."""
    if not info.is_pdf or request.text_layer_strategy == "always-ocr":
        return (frozenset(), None)
    probe = probe_pdf(info.path)
    return (pages_to_skip(probe, request.text_layer_strategy), probe)


def _write_outputs(
    request: JobRequest,
    result: DocumentResult,
    writers: list[OutputWriter],
) -> Iterator[SidecarMessage]:
    """Run every writer, reporting each file as it appears.

    One writer failing does not abort the rest: a broken .xlsx should not cost the user the
    Markdown and JSON that already succeeded. The backend decides whether a partial set is
    acceptable.
    """
    context = WriteContext(
        work_dir=Path(request.work_dir),
        output_stem=request.output_stem,
        source_path=Path(request.source_path),
    )

    for writer in writers:
        try:
            for written in writer.write(result, context):
                yield OutputMessage(
                    job_id=request.job_id,
                    format=written.format,
                    path=str(written.path.relative_to(context.work_dir)),
                    bytes=written.bytes,
                )
        except SidecarError as error:
            yield LogMessage(
                job_id=request.job_id,
                level="error",
                message=f"Could not write {writer.format}: {error.message}",
            )
