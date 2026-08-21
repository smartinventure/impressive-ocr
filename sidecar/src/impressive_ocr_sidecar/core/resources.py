# SPDX-License-Identifier: AGPL-3.0-or-later
"""Keep OCR from taking the whole machine.

PaddleOCR, oneDNN and OpenMP all default to "use every core", and each thread carries its own
working buffers. On a 16 GB laptop that turns a background job into an unusable computer: the
fan spins up, resident memory climbs past what is free, and the machine starts swapping — at
which point CPU *drops* to 10-30% while everything takes minutes, because it is waiting on the
disk rather than computing.

Capping threads is the lever that helps twice. Fewer threads means less CPU contention and,
because each one allocates, materially less memory.

These have to be set as environment variables *before* Paddle is imported: OpenMP reads its
configuration once, at load time, and ignores later changes.
"""

from __future__ import annotations

import os

#: Never go below this. One thread is pathologically slow, and the point is to leave the
#: machine usable, not to make OCR take all day.
MIN_THREADS = 1

#: Above this the returns are gone anyway for these models, and the memory cost is not.
MAX_THREADS = 16


def resolve_thread_count(cpu_count: int | None, budget_percent: int) -> int:
    """Threads to allow, from a share of the machine.

    Rounds down, so 50% of a 12-core machine is 6 and 50% of a single core is still 1.
    """
    cores = cpu_count if cpu_count and cpu_count > 0 else 1
    share = max(MIN_THREADS, int(cores * max(1, min(100, budget_percent)) / 100))
    return min(share, MAX_THREADS)


def apply_thread_limits(threads: int) -> dict[str, str]:
    """Set every thread knob the stack reads, and report what was set.

    All of them, because they are read by different layers: OpenMP by oneDNN's kernels, MKL by
    anything falling back to it, and ``FLAGS_paddle_num_threads`` by Paddle itself. Setting one
    and not the others leaves whichever was missed defaulting to every core.
    """
    bounded = max(MIN_THREADS, min(MAX_THREADS, threads))
    value = str(bounded)

    applied = {
        "OMP_NUM_THREADS": value,
        "MKL_NUM_THREADS": value,
        "OPENBLAS_NUM_THREADS": value,
        "NUMEXPR_NUM_THREADS": value,
        "FLAGS_paddle_num_threads": value,
    }
    for name, setting in applied.items():
        # Not `setdefault`: an operator who exported one of these deliberately is overridden
        # here on purpose, because the app's own setting is the more specific instruction.
        os.environ[name] = setting

    return applied
