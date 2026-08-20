# SPDX-License-Identifier: AGPL-3.0-or-later
"""Engine construction and the process-wide warm-model cache."""

from __future__ import annotations

import threading

from ..core.config import Device, EngineProfile
from ..core.logging import get_logger
from ..core.protocol import EngineModules
from .base import OcrEngine
from .structure_engine import StructureEngine
from .vl_engine import VlEngine

_logger = get_logger()


def create_engine(
    profile: EngineProfile,
    device: Device,
    modules: EngineModules | None = None,
) -> OcrEngine:
    """Build (but do not load) the engine for a profile/device pair.

    The module toggles are needed here, not just at predict time: PP-StructureV3 downloads
    and instantiates its sub-models in its constructor.
    """
    if profile == "accurate":
        return VlEngine(device=device)
    return StructureEngine(device=device, modules=modules)


class EngineCache:
    """Holds the one loaded engine for this process.

    A sidecar is pinned to a single profile/device pair, so this never holds more than one
    engine — the class exists to make loading thread-safe and lazy. It is the deliberate
    exception to the project's no-global-mutable-state rule: model weights cost gigabytes
    and minutes to load, so they must outlive a single request.
    """

    def __init__(
        self,
        profile: EngineProfile,
        device: Device,
        modules: EngineModules | None = None,
    ) -> None:
        self._profile = profile
        self._device = device
        # Fixed for the process's lifetime. A job asking for a different set gets the loaded
        # engine anyway — changing them would mean reloading gigabytes of weights mid-queue,
        # so the backend starts a separate worker instead.
        self._modules = modules
        self._engine: OcrEngine | None = None
        self._lock = threading.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._engine is not None

    def get(self) -> OcrEngine:
        """Return the loaded engine, loading it on first use.

        The lock matters: uvicorn serves the health endpoint on a thread pool, so two
        requests can race the first job and start two multi-gigabyte model loads.
        """
        # Read into a local each time: re-reading the attribute is what lets the value
        # legitimately change between the unlocked fast path and the locked slow path.
        cached = self._engine
        if cached is not None:
            return cached

        with self._lock:
            cached = self._engine
            if cached is not None:
                return cached
            engine = create_engine(self._profile, self._device, self._modules)
            _logger.info(
                "Loading engine",
                extra={"engine": engine.name, "profile": self._profile, "device": self._device},
            )
            engine.load()
            self._engine = engine
            return engine

    def version(self) -> str:
        return self._engine.version() if self._engine is not None else "not-loaded"
