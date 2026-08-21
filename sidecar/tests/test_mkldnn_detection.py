# SPDX-License-Identifier: AGPL-3.0-or-later
"""When oneDNN (MKL-DNN) must be switched off.

PaddleX enables it by default for CPU inference. Where it misbehaves, inference fails inside
``onednn_instruction.cc`` with

    (Unimplemented) ConvertPirAttribute2RuntimeAttribute
    not support [pir::ArrayAttribute<pir::DoubleAttribute>]

and in the full document pipeline it can kill the process with no traceback at all.

It was first hit on a Snapdragon X laptop and recorded as an emulation problem. It is not:
the identical error was later measured on a **native x86-64 Windows machine** (i7-11700F,
PaddlePaddle 3.3.1, CPU profile), where the emulation check said oneDNN was safe and every
CPU job was quarantined as a corrupt document. Hence the Windows rule below, which is the
one that matters in practice — the emulation rule now only covers non-Windows hosts.
"""

from __future__ import annotations

import pytest

from impressive_ocr_sidecar.engines.structure_engine import use_mkldnn


class TestUseMkldnn:
    def test_disabled_on_native_windows_x86(self) -> None:
        # The regression this exists for: a real Intel desktop, no emulation, and oneDNN
        # still fails. Every Windows CPU job was quarantined until this returned False.
        assert use_mkldnn("AMD64", "win-amd64", "Windows") is False

    def test_disabled_on_windows_even_without_the_system_name(self) -> None:
        # sysconfig alone is enough to recognise Windows; the caller need not pass both.
        assert use_mkldnn("AMD64", "win-amd64") is False

    def test_enabled_on_real_x86_hardware_elsewhere(self) -> None:
        assert use_mkldnn("x86_64", "linux-x86_64", "Linux") is True

    def test_disabled_for_an_x86_build_on_an_arm_host(self) -> None:
        # The Snapdragon X case, and its Linux equivalent: the host is ARM64 while the
        # interpreter is an x86-64 binary, so the process is being emulated.
        assert use_mkldnn("ARM64", "win-amd64", "Windows") is False
        assert use_mkldnn("aarch64", "linux-x86_64", "Linux") is False

    def test_enabled_on_native_arm(self) -> None:
        # A genuinely native ARM build is not emulated, so there is nothing to work around.
        assert use_mkldnn("arm64", "macosx-14.0-arm64", "Darwin") is True
        assert use_mkldnn("aarch64", "linux-aarch64", "Linux") is True

    @pytest.mark.parametrize("machine", ["ARM64", "arm64", "AARCH64"])
    def test_host_detection_is_case_insensitive(self, machine: str) -> None:
        assert use_mkldnn(machine, "linux-x86_64", "Linux") is False

    def test_unknown_values_default_to_enabled(self) -> None:
        # Unrecognised means "no evidence of a problem"; leaving the optimisation on matches
        # PaddleX's own default rather than silently slowing every other platform down.
        assert use_mkldnn("", "") is True
