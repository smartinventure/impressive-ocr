# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP surface: health, capabilities, and the streaming job endpoint."""

from __future__ import annotations

import asyncio
import json
import platform
import sys
import time
from collections.abc import AsyncIterator, Generator
from typing import Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from ..core.config import PROTOCOL_VERSION
from ..core.errors import SidecarError
from ..core.logging import get_logger
from ..core.protocol import (
    CapabilitiesResponse,
    ErrorMessage,
    HealthResponse,
    JobRequest,
    SidecarMessage,
)
from ..pipeline.job_runner import run_job
from ..writers.registry import SUPPORTED_FORMATS
from .security import require_token

_logger = get_logger()

router = APIRouter()


@router.get("/health", response_model=None)
async def health(request: Request) -> HealthResponse:
    """Liveness probe. Deliberately unauthenticated and free of any model access.

    The backend polls this to decide whether to restart the process, so it must answer even
    while a multi-gigabyte model load is in flight — hence `starting` as a distinct state
    rather than a timeout.
    """
    state = request.app.state
    status: Literal["starting", "ready", "busy"] = (
        "ready" if state.engine_cache.is_loaded else "starting"
    )
    if state.busy_jobs > 0:
        status = "busy"
    return HealthResponse(
        status=status,
        uptime_seconds=time.monotonic() - state.started_at,
    )


@router.get("/capabilities", response_model=None, dependencies=[Depends(require_token)])
async def capabilities(request: Request) -> CapabilitiesResponse:
    """What this build can actually do, so the backend never offers the user a dead option."""
    config = request.app.state.config
    return CapabilitiesResponse(
        python_version=platform.python_version(),
        paddle_version=_module_version("paddle"),
        paddleocr_version=_module_version("paddleocr"),
        device=config.device,
        profile=config.profile,
        supported_formats=list(SUPPORTED_FORMATS),
    )


@router.post("/jobs", dependencies=[Depends(require_token)])
async def create_job(job: JobRequest, request: Request) -> StreamingResponse:
    """Process one document, streaming NDJSON progress.

    Returns a stream rather than a completed result because a job can run for many minutes;
    the UI needs page-level progress, and the backend needs to notice a stalled worker.
    """
    return StreamingResponse(
        _stream_job(job, request),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Protocol-Version": str(PROTOCOL_VERSION)},
    )


async def _stream_job(job: JobRequest, request: Request) -> AsyncIterator[bytes]:
    """Bridge the synchronous job generator onto the async response stream.

    ``run_job`` is CPU-bound and synchronous, so each step runs in a worker thread. Without
    that the event loop would block and the health endpoint would stop answering for the
    whole document — which the backend would read as a hung worker and kill.
    """
    state = request.app.state
    state.busy_jobs += 1
    try:
        try:
            engine = await asyncio.to_thread(state.engine_cache.get)
        except SidecarError as error:
            # Loading happens outside run_job, so its failures need converting here too.
            # Letting one escape would truncate the stream and leave the backend unable to
            # tell "engine missing" (retry) from "corrupt document" (quarantine).
            _logger.error("Engine load failed", extra={"jobId": job.job_id}, exc_info=error)
            yield _encode(
                ErrorMessage(
                    job_id=job.job_id,
                    code=error.code,
                    message=error.message,
                    retryable=error.retryable,
                )
            )
            return

        generator = run_job(job, engine)

        while True:
            message = await asyncio.to_thread(_next_or_none, generator)
            if message is None:
                break
            yield _encode(message)

            if await request.is_disconnected():
                _logger.warning(
                    "Backend disconnected; abandoning job", extra={"jobId": job.job_id}
                )
                generator.close()
                break
    finally:
        state.busy_jobs -= 1


def _next_or_none(
    generator: Generator[SidecarMessage, None, None],
) -> SidecarMessage | None:
    """Advance the job generator, mapping exhaustion onto ``None``.

    ``StopIteration`` cannot cross ``asyncio.to_thread`` intact, so it is converted here
    rather than in the caller.
    """
    try:
        return next(generator)
    except StopIteration:
        return None


def _encode(message: SidecarMessage) -> bytes:
    """One JSON object per line, camelCase to match the TypeScript contract."""
    payload = message.model_dump(by_alias=True, mode="json")
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


def _module_version(module_name: str) -> str:
    """Version of an optional dependency without importing the heavy module itself."""
    module = sys.modules.get(module_name)
    if module is not None:
        return str(getattr(module, "__version__", "unknown"))
    try:
        from importlib.metadata import version

        return version(module_name)
    except Exception:  # noqa: BLE001 - absence is normal before the runtime is installed
        return "not-installed"
