# SPDX-License-Identifier: AGPL-3.0-or-later
"""The job stream must not fall silent while an engine is working.

PaddleOCR-VL parses a whole PDF before it yields its first page, so a long document
produces no messages for many minutes. The backend's HTTP client abandons a response body
that has been idle for five minutes, which failed healthy jobs with the error "terminated"
after the GPU had already done the work.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Generator, Iterator
from typing import Any

import pytest

from impressive_ocr_sidecar.api import routes
from impressive_ocr_sidecar.core.config import SidecarConfig
from impressive_ocr_sidecar.core.protocol import (
    AcceptedMessage,
    DoneMessage,
    EngineOptions,
    JobRequest,
    SidecarMessage,
)


class _FakeState:
    """Just enough of ``app.state`` for the streaming bridge."""

    def __init__(self) -> None:
        self.busy_jobs = 0
        self.engine_cache = _FakeEngineCache()


class _FakeEngineCache:
    def get(self) -> object:
        return object()


class _FakeRequest:
    """A backend that stays connected for the whole job."""

    def __init__(self) -> None:
        self.app = type("App", (), {"state": _FakeState()})()

    async def is_disconnected(self) -> bool:
        return False


def _job(tmp_path: Any) -> JobRequest:
    return JobRequest(
        job_id="job-1",
        source_path=str(tmp_path / "input.pdf"),
        work_dir=str(tmp_path),
        output_stem="out",
        profile="accurate",
        device="gpu",
        formats=["markdown"],
        engine=EngineOptions(),
        text_layer_strategy="always-ocr",
    )


async def _collect(job: JobRequest) -> list[bytes]:
    return [frame async for frame in routes._stream_job(job, _FakeRequest())]


class TestJobStreamKeepalive:
    @pytest.fixture(autouse=True)
    def _fast_keepalive(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Real interval is 30s; the point is the behaviour, not the duration.
        monkeypatch.setattr(routes, "KEEPALIVE_INTERVAL_SECONDS", 0.02)

    def test_emits_keepalives_while_a_page_is_being_recognised(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any, config: SidecarConfig
    ) -> None:
        def slow_job(request: JobRequest, engine: object) -> Generator[SidecarMessage, None, None]:
            yield AcceptedMessage(job_id=request.job_id, page_count=20)
            # The engine, chewing on a document and saying nothing.
            import time

            time.sleep(0.3)
            yield DoneMessage(job_id=request.job_id, page_count=20, duration_ms=300.0)

        monkeypatch.setattr(routes, "run_job", slow_job)

        frames = asyncio.run(_collect(_job(tmp_path)))

        keepalives = [frame for frame in frames if frame == routes.KEEPALIVE_FRAME]
        assert keepalives, 'the stream went silent for the whole of the engine"s work'

    def test_keepalives_are_blank_lines_the_backend_discards(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        def slow_job(request: JobRequest, engine: object) -> Generator[SidecarMessage, None, None]:
            import time

            time.sleep(0.15)
            yield DoneMessage(job_id=request.job_id, page_count=1, duration_ms=150.0)

        monkeypatch.setattr(routes, "run_job", slow_job)

        frames = asyncio.run(_collect(_job(tmp_path)))

        # A keepalive must carry no payload: the backend's line reader drops blank lines, so
        # anything else here would have to become a versioned message type on both sides.
        assert routes.KEEPALIVE_FRAME.strip() == b""

        messages = [json.loads(frame) for frame in frames if frame.strip()]
        assert [message["type"] for message in messages] == ["done"]

    def test_messages_still_arrive_in_order(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
    ) -> None:
        def quick_job(request: JobRequest, engine: object) -> Iterator[SidecarMessage]:
            yield AcceptedMessage(job_id=request.job_id, page_count=1)
            yield DoneMessage(job_id=request.job_id, page_count=1, duration_ms=1.0)

        monkeypatch.setattr(routes, "run_job", quick_job)

        frames = asyncio.run(_collect(_job(tmp_path)))
        messages = [json.loads(frame) for frame in frames if frame.strip()]

        assert [message["type"] for message in messages] == ["accepted", "done"]
