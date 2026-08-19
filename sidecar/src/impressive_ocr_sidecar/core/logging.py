# SPDX-License-Identifier: AGPL-3.0-or-later
"""Structured JSON logging on stderr.

stdout is reserved for the handshake line the parent process parses, so every log record
goes to stderr. The backend forwards these into its own pino stream, which is why the
format is JSON rather than human-readable text.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

LOGGER_NAME = "impressive_ocr_sidecar"

_LEVELS = {
    "trace": logging.DEBUG,
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}


class JsonFormatter(logging.Formatter):
    """Renders records as one JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED:
                payload[key] = value
        if record.exc_info is not None:
            payload["err"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str) -> logging.Logger:
    """Install the JSON handler on stderr and return the sidecar's root logger."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(_LEVELS.get(level.lower(), logging.INFO))

    # uvicorn installs its own handlers; route them through ours instead.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True

    return logging.getLogger(LOGGER_NAME)


def get_logger() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)
