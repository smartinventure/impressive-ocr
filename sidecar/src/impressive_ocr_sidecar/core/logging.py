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


#: Third-party loggers held at WARNING regardless of the configured level.
#:
#: The root logger is set to the level the backend asked for, and everything propagates
#: through the JSON handler -- including libraries that narrate their own work. `httpx` logs
#: one INFO line per request, and the accurate profile makes a request per layout region, so
#: a single document wrote a hundred lines saying a POST had happened.
#:
#: They are quietened rather than silenced: at `debug` they come back, which is when someone
#: is actually looking at why a request failed.
_CHATTY_LIBRARIES = ("httpx", "httpcore", "urllib3")


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

    # Left alone when the caller asked for debug or trace: that is someone looking into why a
    # request failed, and the request log is the thing they came for.
    if root.level > logging.DEBUG:
        for name in _CHATTY_LIBRARIES:
            logging.getLogger(name).setLevel(logging.WARNING)

    return logging.getLogger(LOGGER_NAME)


def get_logger() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)
