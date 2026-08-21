// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpus, freemem, totalmem } from 'node:os';

/**
 * Live CPU and memory, for the dashboard.
 *
 * Worth surfacing because the failure mode this product actually hits is not "slow" but
 * "swapping": memory pegged near 100% while CPU sits at 10-30%, because every core is waiting
 * on the disk. Those two numbers side by side are what makes that legible — one of them alone
 * looks like the machine is idle.
 */

export interface ResourceUsage {
  /** Share of the CPU busy since the previous sample, 0-1. Null on the first call. */
  cpuBusyFraction: number | null;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  /** 0-1. Anything above ~0.9 is where a document starts taking minutes per page. */
  memoryUsedFraction: number;
  /** Resident set of this process, which is the backend rather than the OCR worker. */
  processMemoryBytes: number;
}

interface CpuSample {
  idle: number;
  total: number;
}

/**
 * Samples CPU between calls.
 *
 * `os.cpus()` reports cumulative tick counters since boot, so a single reading says nothing
 * about *now* — the value is the difference between two samples. Holding the previous one is
 * the whole reason this is a class rather than a function.
 */
export class ResourceMonitor {
  private previous: CpuSample | null = null;

  sample(): ResourceUsage {
    const current = readCpuTicks();
    const busy = this.busySince(current);
    this.previous = current;

    const total = totalmem();
    const free = freemem();

    return {
      cpuBusyFraction: busy,
      totalMemoryBytes: total,
      freeMemoryBytes: free,
      memoryUsedFraction: total === 0 ? 0 : (total - free) / total,
      processMemoryBytes: process.memoryUsage().rss,
    };
  }

  private busySince(current: CpuSample): number | null {
    const previous = this.previous;
    if (previous === null) return null;

    const totalDelta = current.total - previous.total;
    if (totalDelta <= 0) return null;

    const idleDelta = current.idle - previous.idle;
    const busy = 1 - idleDelta / totalDelta;
    // Counter wraparound and hypervisor time accounting can both put this outside 0-1.
    return Math.min(1, Math.max(0, busy));
  }
}

function readCpuTicks(): CpuSample {
  let idle = 0;
  let total = 0;

  for (const core of cpus()) {
    idle += core.times.idle;
    total += core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq;
  }

  return { idle, total };
}
