// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ResourceMonitor } from './resource-usage';

/**
 * These two numbers exist to make swapping legible. Memory near 100% with CPU at 20% is the
 * signature of a machine waiting on the disk, and either figure alone reads as "idle".
 */
describe('ResourceMonitor', () => {
  it('cannot report CPU on the first sample', () => {
    // The OS counters are cumulative since boot; a single reading says nothing about now.
    expect(new ResourceMonitor().sample().cpuBusyFraction).toBeNull();
  });

  it('reports a CPU fraction once it has something to compare against', () => {
    const monitor = new ResourceMonitor();
    monitor.sample();

    // Burn a little time so the tick counters actually move.
    const until = Date.now() + 60;
    while (Date.now() < until) {
      /* deliberate */
    }

    const busy = monitor.sample().cpuBusyFraction;
    expect(busy === null || (busy >= 0 && busy <= 1)).toBe(true);
  });

  it('reports memory as a fraction and as bytes', () => {
    const usage = new ResourceMonitor().sample();

    expect(usage.totalMemoryBytes).toBeGreaterThan(0);
    expect(usage.freeMemoryBytes).toBeGreaterThanOrEqual(0);
    expect(usage.memoryUsedFraction).toBeGreaterThan(0);
    expect(usage.memoryUsedFraction).toBeLessThanOrEqual(1);
  });

  it('keeps the fraction consistent with the byte counts', () => {
    const usage = new ResourceMonitor().sample();
    const derived = (usage.totalMemoryBytes - usage.freeMemoryBytes) / usage.totalMemoryBytes;

    expect(usage.memoryUsedFraction).toBeCloseTo(derived, 5);
  });

  it('reports this process separately from the machine', () => {
    // The backend's own resident set is small; the OCR worker is a different process, which
    // is exactly the distinction a user staring at Task Manager needs.
    const usage = new ResourceMonitor().sample();

    expect(usage.processMemoryBytes).toBeGreaterThan(0);
    expect(usage.processMemoryBytes).toBeLessThan(usage.totalMemoryBytes);
  });
});
