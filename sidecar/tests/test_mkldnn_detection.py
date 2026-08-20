# SPDX-License-Identifier: AGPL-3.0-or-later
"""oneDNN must be off when an x86-64 build runs under emulation on an ARM64 host.

Found by running on a Snapdragon X Windows laptop. PaddleX enables MKL-DNN by default for
CPU inference; emulated, it fails inside ``onednn_instruction.cc`` with

    NotImplementedError: (Unimplemented) ConvertPirAttribute2RuntimeAttribute
    not support [pir::ArrayAttribute<pir::DoubleAttribute>]

and in the full document pipeline it kills the process with no traceback at all. With it
disabled the same page OCR'd correctly in 36 seconds.
"""

from __future__ import annotations

import pytest

from impressive_ocr_sidecar.engines.structure_engine import use_mkldnn


class TestUseMkldnn:
    def test_enabled_on_real_x86_hardware(self) -> None:
        assert use_mkldnn("AMD64", "win-amd64") is True
        assert use_mkldnn("x86_64", "linux-x86_64") is True

    def test_disabled_for_an_x86_build_on_an_arm_host(self) -> None:
        # The Snapdragon X case: Windows reports the ARM64 host, the interpreter is win-amd64,
        # so the process is running under Prism emulation.
        assert use_mkldnn("ARM64", "win-amd64") is False
        assert use_mkldnn("aarch64", "linux-x86_64") is False

    def test_enabled_on_native_arm(self) -> None:
        # A genuinely native ARM build is not emulated, so there is nothing to work around.
        assert use_mkldnn("arm64", "macosx-14.0-arm64") is True
        assert use_mkldnn("aarch64", "linux-aarch64") is True

    @pytest.mark.parametrize("machine", ["ARM64", "arm64", "AARCH64"])
    def test_host_detection_is_case_insensitive(self, machine: str) -> None:
        assert use_mkldnn(machine, "win-amd64") is False

    def test_unknown_values_default_to_enabled(self) -> None:
        # Unrecognised means "no evidence of emulation"; leaving the optimisation on matches
        # PaddleX's own default rather than silently slowing every other platform down.
        assert use_mkldnn("", "") is True
