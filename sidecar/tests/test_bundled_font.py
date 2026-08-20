# SPDX-License-Identifier: AGPL-3.0-or-later
"""The visualization font must ship with us, not arrive from a CDN.

Left to itself PaddleX downloads PingFang-SC-Regular.ttf and simfang.ttf from a Baidu CDN the
first time it renders an overlay. Both are proprietary (Apple; Beijing Founder), so they can
neither be redistributed under AGPL nor fetched at all on an offline install — and reaching
out at inference time breaks the promise that nothing about a user's documents leaves their
machine.
"""

from __future__ import annotations

import os
from pathlib import Path

from impressive_ocr_sidecar.core.config import (
    SidecarConfig,
    apply_paddle_environment,
    bundled_font_path,
)


class TestBundledFont:
    def test_the_font_is_actually_present(self) -> None:
        font = bundled_font_path()
        assert font.is_file(), f"{font} is missing - the wheel would fall back to the CDN"

    def test_it_is_a_real_truetype_file(self) -> None:
        # A truncated or LFS-pointer file would still satisfy is_file().
        header = bundled_font_path().read_bytes()[:4]
        assert header in (b"\x00\x01\x00\x00", b"true", b"ttcf"), f"not a TTF: {header!r}"

    def test_its_licence_ships_beside_it(self) -> None:
        licence = bundled_font_path().parent / "LICENSE-DejaVu.txt"
        assert licence.is_file(), "redistributing the font requires shipping its licence"
        assert "Bitstream" in licence.read_text(encoding="utf-8", errors="replace")

    def test_paddle_is_pointed_at_it(self, tmp_path: Path, monkeypatch) -> None:
        monkeypatch.delenv("PADDLE_PDX_LOCAL_FONT_FILE_PATH", raising=False)
        apply_paddle_environment(_config(tmp_path))
        configured = os.environ["PADDLE_PDX_LOCAL_FONT_FILE_PATH"]
        assert Path(configured) == bundled_font_path()
        assert Path(configured).is_file()

    def test_an_explicit_operator_choice_still_wins(self, tmp_path: Path, monkeypatch) -> None:
        chosen = tmp_path / "corporate.ttf"
        chosen.write_bytes(b"\x00\x01\x00\x00")
        monkeypatch.setenv("PADDLE_PDX_LOCAL_FONT_FILE_PATH", str(chosen))
        apply_paddle_environment(_config(tmp_path))
        assert os.environ["PADDLE_PDX_LOCAL_FONT_FILE_PATH"] == str(chosen)


def _config(tmp_path: Path) -> SidecarConfig:
    """A minimal config; only ``model_cache_dir`` matters to these tests."""
    return SidecarConfig(
        host="127.0.0.1",
        port=0,
        auth_token="test-token",
        profile="fast",
        device="cpu",
        model_cache_dir=str(tmp_path / "models"),
        log_level="INFO",
    )
