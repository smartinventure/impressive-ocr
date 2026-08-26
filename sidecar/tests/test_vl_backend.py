# SPDX-License-Identifier: AGPL-3.0-or-later
"""Selecting the vision-language inference backend.

PaddleOCR's own backend recognises one layout region at a time; pointed at a server that
batches them, the same weights run ~28x faster. The mapping between our settings and its
constructor keywords is therefore the difference between a 2-second page and a 56-second one,
and it has to fail loudly rather than quietly reverting to the slow path.
"""

from __future__ import annotations

import pytest

from impressive_ocr_sidecar.core.config import (
    ConfigError,
    VlServerSettings,
    load_config,
)
from impressive_ocr_sidecar.engines.registry import create_engine
from impressive_ocr_sidecar.engines.vl_engine import build_backend_kwargs

_REQUIRED_ENV = {
    "IMPRESSIVE_OCR_TOKEN": "test-token",
    "IMPRESSIVE_OCR_MODEL_CACHE_DIR": "/tmp/models",
    "IMPRESSIVE_OCR_PROFILE": "accurate",
    "IMPRESSIVE_OCR_DEVICE": "gpu",
}


def _environment(monkeypatch: pytest.MonkeyPatch, **extra: str) -> None:
    for name in [
        *_REQUIRED_ENV,
        "IMPRESSIVE_OCR_VL_BACKEND",
        "IMPRESSIVE_OCR_VL_SERVER_URL",
        "IMPRESSIVE_OCR_VL_MAX_CONCURRENCY",
    ]:
        monkeypatch.delenv(name, raising=False)
    for name, value in {**_REQUIRED_ENV, **extra}.items():
        monkeypatch.setenv(name, value)


class TestBackendKwargs:
    def test_sends_nothing_when_no_server_is_configured(self) -> None:
        # Not the same as sending `vl_rec_backend=None`: PaddleOCR validates the value
        # against its supported list before deciding whether it was set at all.
        assert build_backend_kwargs(None) == {}

    def test_sends_backend_and_url(self) -> None:
        kwargs = build_backend_kwargs(
            VlServerSettings(backend="llama-cpp-server", url="http://127.0.0.1:9/v1")
        )

        assert kwargs == {
            "vl_rec_backend": "llama-cpp-server",
            "vl_rec_server_url": "http://127.0.0.1:9/v1",
        }

    def test_sends_concurrency_when_set(self) -> None:
        kwargs = build_backend_kwargs(
            VlServerSettings(
                backend="llama-cpp-server", url="http://127.0.0.1:9/v1", max_concurrency=8
            )
        )

        assert kwargs["vl_rec_max_concurrency"] == 8

    def test_omits_concurrency_when_unset(self) -> None:
        # PaddleOCR's own default is far above anything a page needs; pinning a number we
        # did not choose would be worse than leaving it alone.
        kwargs = build_backend_kwargs(
            VlServerSettings(backend="llama-cpp-server", url="http://127.0.0.1:9/v1")
        )

        assert "vl_rec_max_concurrency" not in kwargs


class TestConfigFromEnvironment:
    def test_absent_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _environment(monkeypatch)

        assert load_config().vl_server is None

    def test_read_together(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _environment(
            monkeypatch,
            IMPRESSIVE_OCR_VL_BACKEND="llama-cpp-server",
            IMPRESSIVE_OCR_VL_SERVER_URL="http://127.0.0.1:8118/v1",
            IMPRESSIVE_OCR_VL_MAX_CONCURRENCY="8",
        )

        vl_server = load_config().vl_server

        assert vl_server is not None
        assert vl_server.backend == "llama-cpp-server"
        assert vl_server.url == "http://127.0.0.1:8118/v1"
        assert vl_server.max_concurrency == 8

    def test_half_a_configuration_is_an_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A URL with no backend name is silently ignored by PaddleOCR, which surfaces months
        # later as "why is accurate mode slow" rather than as a misconfiguration.
        _environment(monkeypatch, IMPRESSIVE_OCR_VL_SERVER_URL="http://127.0.0.1:8118/v1")

        with pytest.raises(ConfigError):
            load_config()

    def test_a_non_numeric_concurrency_is_an_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _environment(
            monkeypatch,
            IMPRESSIVE_OCR_VL_BACKEND="llama-cpp-server",
            IMPRESSIVE_OCR_VL_SERVER_URL="http://127.0.0.1:8118/v1",
            IMPRESSIVE_OCR_VL_MAX_CONCURRENCY="eight",
        )

        with pytest.raises(ConfigError):
            load_config()


class TestEngineSelection:
    def test_accurate_receives_the_server(self) -> None:
        settings = VlServerSettings(backend="llama-cpp-server", url="http://127.0.0.1:9/v1")

        engine = create_engine("accurate", "cpu", None, settings)

        assert build_backend_kwargs(engine._vl_server) != {}

    def test_fast_ignores_it(self) -> None:
        # PP-StructureV3 has no language model to serve, so the setting is meaningless for
        # it rather than merely unused.
        settings = VlServerSettings(backend="llama-cpp-server", url="http://127.0.0.1:9/v1")

        engine = create_engine("fast", "cpu", None, settings)

        assert not hasattr(engine, "_vl_server")
