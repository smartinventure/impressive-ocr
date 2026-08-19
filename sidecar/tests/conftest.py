# SPDX-License-Identifier: AGPL-3.0-or-later
"""Shared fixtures.

Nothing here imports PaddleOCR: the sidecar's own logic — input inspection, the text-layer
probe, option mapping, writers — must be testable without a multi-gigabyte install, or it
will not get tested.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from impressive_ocr_sidecar.core.config import SidecarConfig


@pytest.fixture
def config(tmp_path: Path) -> SidecarConfig:
    return SidecarConfig(
        host="127.0.0.1",
        port=0,
        auth_token="test-token",
        profile="fast",
        device="cpu",
        model_cache_dir=str(tmp_path / "models"),
        log_level="error",
    )


@pytest.fixture
def digital_pdf(tmp_path: Path) -> Path:
    """A born-digital PDF with a real text layer, for the probe tests."""
    import pymupdf

    path = tmp_path / "digital.pdf"
    document = pymupdf.open()
    page = document.new_page()
    body = (
        "Rechnung Nr. 4711\n"
        "Kunde: ABC GmbH, Musterstrasse 5, 80331 Muenchen\n"
        "Position 1: Widget A, Menge 3, Preis 20,00 EUR\n"
        "Position 2: Widget B, Menge 1, Preis 63,50 EUR\n"
        "Gesamtbetrag: 123,50 EUR inklusive Mehrwertsteuer\n"
        "Zahlbar innerhalb von 30 Tagen ohne Abzug.\n"
    )
    page.insert_text((72, 100), body, fontsize=11)
    document.save(path)
    document.close()
    return path


@pytest.fixture
def scanned_pdf(tmp_path: Path) -> Path:
    """A PDF with no extractable text, standing in for a scan."""
    import pymupdf

    path = tmp_path / "scanned.pdf"
    document = pymupdf.open()
    document.new_page()
    document.save(path)
    document.close()
    return path
