// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pipelineOptionsSchema,
  type HardwareCapabilities,
  type Job,
  type Pipeline,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import type { EventBus } from '../events/event-bus';
import type { JobExecutor } from './job-executor';
import type { JobRepository } from './job-repository';
import { Scheduler, type SchedulerOptions } from './scheduler';

/**
 * The scheduler must not spend a job's retries on its own bookkeeping.
 *
 * `claimNext` counts an attempt, so a tick that claims a job and hands it straight back
 * charges the document for a try that never happened. With a GPU lane of one and an accurate
 * run taking half an hour, a queued document accumulated hundreds of "attempts" while sitting
 * still, and was then quarantined by its first genuine failure with no retry left to spend.
 */

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p1',
    name: 'Patents',
    description: '',
    enabled: true,
    kind: 'watched',
    options: pipelineOptionsSchema.parse({
      source: { inputPath: 'D:\\in' },
      output: { outputPath: 'D:\\out' },
      engine: { profile: 'accurate', device: 'gpu' },
    }),
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function gpuHardware(): HardwareCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalMemoryBytes: 32 * 1024 ** 3,
    gpu: null,
    gpuUnavailableReason: null,
    canUseGpu: true,
    availableProfiles: ['fast', 'accurate'],
    probedAt: '2026-08-19T00:00:00.000Z',
  };
}

function job(id: string): Job {
  return {
    id,
    pipelineId: 'p1',
    sourcePath: `D:\\in\\${id}.pdf`,
    fileName: `${id}.pdf`,
    sizeBytes: 1024,
    contentHash: null,
    state: 'running',
    priority: 0,
    attempts: 1,
    pageCount: null,
    pagesDone: 0,
    deviceUsed: null,
    deviceFallbackReason: null,
    errorCode: null,
    errorMessage: null,
    outputs: [],
    discoveredAt: '2026-08-19T00:00:00.000Z',
    startedAt: '2026-08-19T00:00:00.000Z',
    finishedAt: null,
    durationMs: null,
  };
}

interface Harness {
  scheduler: Scheduler;
  claimNext: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

/** A scheduler wired to fakes, with one accurate/GPU pipeline and an executor that hangs. */
function harness(queued: Job[]): Harness {
  const pending = [...queued];
  const claimNext = vi.fn(() => pending.shift() ?? null);
  const update = vi.fn();

  const jobs = {
    claimNext,
    update,
    requeueRunning: () => 0,
    statsFor: () => ({ queued: pending.length, running: 0, failed: 0, done: 0 }),
  } as unknown as JobRepository;

  // Never settles: this is the half-hour accurate run that holds the GPU lane.
  const executor = { execute: () => new Promise<void>(() => {}) } as unknown as JobExecutor;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  const options: SchedulerOptions = {
    pipelines: { list: () => [pipeline()] } as unknown as SchedulerOptions['pipelines'],
    jobs,
    executor,
    events: { publish: vi.fn() } as unknown as EventBus,
    logger,
    hardware: gpuHardware,
    isRuntimeReady: () => true,
    isGloballyPaused: () => false,
    maxConcurrentDocuments: () => 1,
  };

  return { scheduler: new Scheduler(options), claimNext, update };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not claim a job while the only device it can use is busy', async () => {
    // Two documents, a GPU lane of one. The first takes the lane and never finishes.
    const { scheduler, claimNext } = harness([job('j1'), job('j2')]);
    scheduler.start();

    // First tick claims j1 and launches it.
    await vi.advanceTimersByTimeAsync(600);
    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(scheduler.runningCount).toBe(1);

    // Twenty further ticks with the GPU saturated. Each one used to claim j2, count an
    // attempt against it, and put it straight back.
    await vi.advanceTimersByTimeAsync(20 * 600);

    expect(claimNext).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('gives the attempt back when a claimed job has no pipeline any more', async () => {
    // The one remaining path that claims and then hands the job back: the pipeline was
    // deleted or disabled between building the eligible list and winning the claim. Rare,
    // but it must still not charge the document for a try that never ran.
    const claimed = job('j1');
    claimed.pipelineId = 'gone';
    const { scheduler, update } = harness([claimed]);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(600);

    expect(update).toHaveBeenCalledWith('j1', {
      state: 'pending',
      startedAt: null,
      attempts: claimed.attempts - 1,
    });
    await scheduler.stop();
  });

  it('claims again once the device frees up', async () => {
    let settle: (() => void) | undefined;
    const pending = [job('j1'), job('j2')];
    const claimNext = vi.fn(() => pending.shift() ?? null);

    const options: SchedulerOptions = {
      pipelines: { list: () => [pipeline()] } as unknown as SchedulerOptions['pipelines'],
      jobs: {
        claimNext,
        update: vi.fn(),
        requeueRunning: () => 0,
        statsFor: () => ({ queued: 0, running: 0, failed: 0, done: 0 }),
      } as unknown as JobRepository,
      executor: {
        execute: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      } as unknown as JobExecutor,
      events: { publish: vi.fn() } as unknown as EventBus,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger,
      hardware: gpuHardware,
      isRuntimeReady: () => true,
      isGloballyPaused: () => false,
      maxConcurrentDocuments: () => 1,
    };
    const scheduler = new Scheduler(options);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(600);
    expect(claimNext).toHaveBeenCalledTimes(1);

    // The first document finishes; the lane is free again.
    settle?.();
    await vi.advanceTimersByTimeAsync(600);

    expect(claimNext).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
