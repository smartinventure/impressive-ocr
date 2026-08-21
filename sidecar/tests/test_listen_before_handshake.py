# SPDX-License-Identifier: AGPL-3.0-or-later
"""The announced port must already accept connections.

The backend treats the ``listening`` handshake as "you may send me work now". Binding a socket
without listening on it does not make that true: the kernel refuses connections to a bound but
non-listening socket, so every request in the window before uvicorn started came back as
ECONNREFUSED. The backend read that as ``fetch failed``, retried against two more freshly
spawned sidecars, and quarantined the document -- for a file that was perfectly fine.

These tests pin the ordering rather than the implementation: whatever the entry point does, a
connection to the announced port must not be refused.
"""

from __future__ import annotations

import socket

from impressive_ocr_sidecar.__main__ import SOCKET_BACKLOG


def _connect(port: int, timeout: float = 1.0) -> bool:
    """Whether a TCP connection to localhost:port is accepted."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(timeout)
        return client.connect_ex(("127.0.0.1", port)) == 0


class TestBacklogConstant:
    def test_is_large_enough_to_absorb_a_worker_pool(self) -> None:
        assert SOCKET_BACKLOG >= 16


class TestBoundVersusListening:
    def test_a_bound_socket_alone_refuses_connections(self) -> None:
        # The bug, demonstrated: this is exactly the state the sidecar announced from.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

            assert not _connect(port), "a bound-but-not-listening socket should refuse"
        finally:
            sock.close()

    def test_listening_makes_the_port_accept_before_anything_serves_it(self) -> None:
        # The fix: nothing is reading from this socket, yet the connection is accepted and
        # queued. That is what lets a slow uvicorn start be slow rather than broken.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", 0))
            sock.listen(SOCKET_BACKLOG)
            port = sock.getsockname()[1]

            assert _connect(port), "a listening socket must accept even before it is served"
        finally:
            sock.close()

    def test_the_entry_point_listens_before_it_prints_the_handshake(self) -> None:
        # Read the source rather than starting a real sidecar: spawning one needs the whole
        # Python runtime and a model cache, which is not what this is about.
        from pathlib import Path

        import impressive_ocr_sidecar.__main__ as entry

        source = Path(entry.__file__).read_text(encoding="utf-8")
        listen_at = source.index("sock.listen(")
        handshake_at = source.index('"event": "listening"', source.index("def main("))

        assert listen_at < handshake_at, "listen() must come before the handshake is printed"
