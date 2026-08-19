# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared-secret authentication for the loopback API.

Loopback is not a security boundary: any process running as the user can reach this port,
and this API reads arbitrary files and writes arbitrary directories. The token — generated
per launch by the backend and passed through the environment — keeps that capability with
the process that owns it.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request, status

from ..core.config import AUTH_HEADER


async def require_token(
    request: Request,
    x_impressive_ocr_token: str | None = Header(default=None, alias=AUTH_HEADER),
) -> None:
    """FastAPI dependency enforcing the shared secret.

    Compared with :func:`hmac.compare_digest` so a wrong guess cannot be narrowed down by
    timing the response.
    """
    expected: str = request.app.state.config.auth_token
    if x_impressive_ocr_token is None or not hmac.compare_digest(
        x_impressive_ocr_token, expected
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing sidecar token",
        )
