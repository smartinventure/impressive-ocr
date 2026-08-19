# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sidecar entry point.

Started by the backend with configuration in the environment. Because the backend asks for
port 0 — letting the OS pick a free port rather than guessing one that might be taken — the
chosen port has to travel back somehow. That is the one line this process writes to stdout:

    {"event": "listening", "port": 51234, "protocolVersion": 1}

Everything else goes to stderr as JSON logs, so the handshake can never be confused with
log output.
"""

from __future__ import annotations

import json
import socket
import sys

import uvicorn

from .api.app import create_app
from .core.config import PROTOCOL_VERSION, ConfigError, load_config
from .core.logging import configure_logging


def main() -> int:
    try:
        config = load_config()
    except ConfigError as error:
        print(json.dumps({"event": "error", "message": str(error)}), file=sys.stderr)
        return 2

    logger = configure_logging(config.log_level)

    # Bind before uvicorn so the real port is known in time for the handshake.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((config.host, config.port))
    except OSError as error:
        logger.error("Could not bind", extra={"host": config.host, "port": config.port})
        print(json.dumps({"event": "error", "message": str(error)}), file=sys.stderr)
        return 3

    port = sock.getsockname()[1]
    print(
        json.dumps({"event": "listening", "port": port, "protocolVersion": PROTOCOL_VERSION}),
        flush=True,
    )

    app = create_app(config)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            log_config=None,
            access_log=False,
            # The model load is synchronous and slow; a short shutdown grace period would
            # turn a normal stop into a SIGKILL mid-write.
            timeout_graceful_shutdown=30,
        )
    )
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
