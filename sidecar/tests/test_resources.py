# SPDX-License-Identifier: AGPL-3.0-or-later
"""Thread limits, which are what keep the machine usable during a run.

Reported from a Snapdragon X laptop: Python resident at 4.2 GB, memory at 97%, CPU only
10-50%, and a five-page document stuck on page 0 for over ten minutes. Low CPU with high
memory is the signature of swapping — the machine was waiting on the disk, not working.
"""

from __future__ import annotations

import os

import pytest

from impressive_ocr_sidecar.core.resources import (
    MAX_THREADS,
    MIN_THREADS,
    apply_thread_limits,
    resolve_thread_count,
)


class TestResolveThreadCount:
    @pytest.mark.parametrize(
        ("cores", "percent", "expected"),
        [
            (12, 50, 6),
            (12, 100, 12),
            (12, 25, 3),
            (8, 50, 4),
            (4, 50, 2),
        ],
    )
    def test_takes_the_requested_share(self, cores: int, percent: int, expected: int) -> None:
        assert resolve_thread_count(cores, percent) == expected

    def test_never_returns_zero(self) -> None:
        # A share that rounds to nothing still has to run; one thread is slow, none is broken.
        assert resolve_thread_count(1, 10) == MIN_THREADS
        assert resolve_thread_count(2, 10) == MIN_THREADS

    def test_survives_an_unknown_core_count(self) -> None:
        assert resolve_thread_count(None, 50) >= MIN_THREADS
        assert resolve_thread_count(0, 50) >= MIN_THREADS

    def test_caps_a_very_large_machine(self) -> None:
        # Past a point the extra threads cost memory and buy nothing for these models.
        assert resolve_thread_count(256, 100) == MAX_THREADS

    def test_clamps_a_nonsensical_percentage(self) -> None:
        assert resolve_thread_count(8, 0) >= MIN_THREADS
        assert resolve_thread_count(8, 500) <= MAX_THREADS


class TestApplyThreadLimits:
    def test_sets_every_knob_the_stack_reads(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "FLAGS_paddle_num_threads"):
            monkeypatch.delenv(name, raising=False)

        applied = apply_thread_limits(4)

        # OpenMP is pinned to 1 on Paddle's own instruction. It prints a warning when this is
        # anything else, because its internal pool then competes with OpenMP's -- and setting
        # it to 1 measurably halved the resident set after model load.
        assert applied["OMP_NUM_THREADS"] == "1"
        assert os.environ["OMP_NUM_THREADS"] == "1"
        assert os.environ["MKL_NUM_THREADS"] == "1"

        # The user's budget travels through Paddle's own flag instead. Lower case on purpose:
        # Paddle reads it case-sensitively.
        assert applied["FLAGS_paddle_num_threads"] == "4"
        assert os.environ["FLAGS_paddle_num_threads"] == "4"

    def test_overrides_an_inherited_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FLAGS_paddle_num_threads", "64")

        apply_thread_limits(2)

        # The app's own setting is the more specific instruction, so it wins.
        assert os.environ["FLAGS_paddle_num_threads"] == "2"

    def test_clamps_out_of_range_requests(self) -> None:
        assert apply_thread_limits(0)["FLAGS_paddle_num_threads"] == str(MIN_THREADS)
        assert apply_thread_limits(9999)["FLAGS_paddle_num_threads"] == str(MAX_THREADS)
