# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sidecar configuration, supplied entirely by the parent process via environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .resources import apply_thread_limits, resolve_thread_count

PROTOCOL_VERSION = 1
AUTH_HEADER = "x-impressive-ocr-token"

EngineProfile = Literal["accurate", "fast"]
Device = Literal["gpu", "cpu"]

_ENV_PREFIX = "IMPRESSIVE_OCR_"

#: Font shipped alongside the sidecar, used by PaddleX when it renders result overlays.
#:
#: Left to itself PaddleX downloads PingFang-SC-Regular.ttf and simfang.ttf from a Baidu CDN
#: on first use. Both are proprietary — Apple and Beijing Founder respectively — so they can
#: neither be redistributed with an AGPL product nor fetched at all on an offline install.
#: DejaVu Sans is 757 KB under the permissive Bitstream Vera licence and covers the Latin
#: scripts this product targets. CJK documents still OCR correctly; only the optional
#: visualization overlay would lack those glyphs.
_BUNDLED_FONT = "DejaVuSans.ttf"


def bundled_font_path() -> Path:
    """Absolute path to the font shipped in ``assets/fonts``."""
    return Path(__file__).resolve().parent.parent / "assets" / "fonts" / _BUNDLED_FONT


class ConfigError(RuntimeError):
    """Raised when the parent process started the sidecar without required settings."""


@dataclass(frozen=True, slots=True)
class SidecarConfig:
    """Immutable settings for one sidecar process.

    A sidecar is pinned to a single profile/device pair for its whole lifetime. Switching
    would mean unloading and reloading multi-gigabyte weights, so the backend starts a
    separate process per combination instead.
    """

    host: str
    port: int
    auth_token: str
    profile: EngineProfile
    device: Device
    model_cache_dir: str
    log_level: str
    #: Share of the machine's cores OCR may use. Applied as a thread cap before Paddle loads.
    cpu_budget_percent: int

    @property
    def is_gpu(self) -> bool:
        return self.device == "gpu"


def _require(name: str) -> str:
    value = os.environ.get(_ENV_PREFIX + name)
    if not value:
        raise ConfigError(f"Missing required environment variable {_ENV_PREFIX}{name}")
    return value


def load_config() -> SidecarConfig:
    """Read configuration from the environment.

    The auth token is required even on loopback: any local process could otherwise POST
    jobs to this port and have it read arbitrary files the user's account can reach.
    """
    # Match statements rather than `in` checks: only pattern matching narrows a str to the
    # Literal type the dataclass expects, so this validates and types in one step.
    profile: EngineProfile
    match _require("PROFILE"):
        case "accurate" | "fast" as valid_profile:
            profile = valid_profile
        case other:
            raise ConfigError(f"Unknown profile {other!r}; expected 'accurate' or 'fast'")

    device: Device
    match _require("DEVICE"):
        case "gpu" | "cpu" as valid_device:
            device = valid_device
        case other:
            raise ConfigError(f"Unknown device {other!r}; expected 'gpu' or 'cpu'")

    return SidecarConfig(
        host=os.environ.get(_ENV_PREFIX + "HOST", "127.0.0.1"),
        # Port 0 lets the OS choose a free port, which the sidecar then reports on stdout.
        port=int(os.environ.get(_ENV_PREFIX + "PORT", "0")),
        auth_token=_require("TOKEN"),
        profile=profile,
        device=device,
        model_cache_dir=_require("MODEL_CACHE_DIR"),
        log_level=os.environ.get(_ENV_PREFIX + "LOG_LEVEL", "info"),
        cpu_budget_percent=int(os.environ.get(_ENV_PREFIX + "CPU_BUDGET_PERCENT", "50")),
    )


def apply_paddle_environment(config: SidecarConfig) -> None:
    """Point every model cache at the app's own directory, before anything is imported.

    PaddleOCR does not download models itself; it delegates to ``huggingface_hub`` and
    ModelScope, and *those* cache under ``~/.cache`` on the system drive no matter where the
    user put their data. Leaving them there means the app silently consumes gigabytes of C:,
    and on a full system drive every download truncates — surfacing as PaddleOCR's
    "No valid PaddlePaddle model found", which mentions neither downloads nor disk space.

    ``setdefault`` throughout: the parent process may already have set these deliberately,
    and an operator's explicit choice must win.
    """
    cache = Path(config.model_cache_dir)

    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(cache))
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "huggingface")
    os.environ.setdefault("HF_HOME", str(cache / "huggingface"))
    os.environ.setdefault("HF_HUB_CACHE", str(cache / "huggingface" / "hub"))
    os.environ.setdefault("MODELSCOPE_CACHE", str(cache / "modelscope"))
    os.environ.setdefault("XDG_CACHE_HOME", str(cache / "xdg"))
    os.environ.setdefault("PADDLE_PDX_LOCAL_FONT_FILE_PATH", str(bundled_font_path()))

    # Thread caps must be set before Paddle is imported: OpenMP reads its configuration once,
    # at load time, and ignores anything set afterwards. Left alone it takes every core, and
    # each thread's buffers are what pushed a 16 GB laptop into swapping.
    threads = resolve_thread_count(os.cpu_count(), config.cpu_budget_percent)
    apply_thread_limits(threads)

    if not config.is_gpu:
        # Belt and braces: keep Paddle off the GPU even if a CUDA build is installed.
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
