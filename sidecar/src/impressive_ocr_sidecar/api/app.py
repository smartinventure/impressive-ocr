# SPDX-License-Identifier: AGPL-3.0-or-later
"""FastAPI application factory."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..core.config import SidecarConfig, apply_paddle_environment
from ..core.logging import get_logger
from ..engines.registry import EngineCache
from .routes import router

_logger = get_logger()


def create_app(config: SidecarConfig) -> FastAPI:
    """Build the ASGI app for one sidecar process.

    Everything mutable hangs off ``app.state`` rather than module globals so tests can spin
    up an isolated app, and so two sidecars in one interpreter could never share an engine.
    """
    apply_paddle_environment(config)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        _logger.info(
            "Sidecar starting",
            extra={"profile": config.profile, "device": config.device},
        )
        yield
        _logger.info("Sidecar stopping")

    app = FastAPI(
        title="Impressive OCR sidecar",
        version="0.1.0",
        lifespan=lifespan,
        # No interactive docs: this is a private, token-authenticated loopback API and the
        # schema endpoints are just extra surface.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    app.state.config = config
    app.state.engine_cache = EngineCache(profile=config.profile, device=config.device)
    app.state.started_at = time.monotonic()
    app.state.busy_jobs = 0

    app.include_router(router)
    return app
