// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  pipelineOptionsSchema,
  type HardwareCapabilities,
  type Pipeline,
} from '@impressive-ocr/shared';
import {
  MAX_RETRY_DELAY_MS,
  canRetry,
  deviceCapacity,
  isPipelineEligible,
  isWithinActiveHours,
  nextAttemptAt,
  resolveDevice,
} from './scheduling-policy';

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'p1',
    name: 'Invoices',
    description: '',
    enabled: true,
    kind: 'watched',
    options: pipelineOptionsSchema.parse({
      source: { inputPath: 'D:\\in' },
      output: { outputPath: 'D:\\out' },
    }),
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function hardware(overrides: Partial<HardwareCapabilities> = {}): HardwareCapabilities {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalMemoryBytes: 32 * 1024 ** 3,
    gpu: null,
    gpuUnavailableReason: 'no-nvidia-driver',
    canUseGpu: false,
    availableProfiles: ['fast'],
    probedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

function withEngine(profile: 'accurate' | 'fast', device: 'auto' | 'gpu' | 'cpu'): Pipeline {
  const base = pipeline();
  return {
    ...base,
    options: { ...base.options, engine: { ...base.options.engine, profile, device } },
  };
}

const gpuAvailable = hardware({
  canUseGpu: true,
  gpuUnavailableReason: null,
  gpu: {
    name: 'NVIDIA RTX 4070',
    vramBytes: 12 * 1024 ** 3,
    computeCapability: 8.9,
    driverVersion: '566.03',
  },
  availableProfiles: ['accurate', 'fast'],
});

describe('resolveDevice', () => {
  it('runs the Accurate profile on a qualifying GPU', () => {
    expect(resolveDevice(withEngine('accurate', 'auto'), gpuAvailable)).toEqual({
      device: 'gpu',
      profile: 'accurate',
      fallbackReason: null,
    });
  });

  it('demotes Accurate to Fast when no GPU is available', () => {
    // Running a 0.9B VLM on a CPU is not a graceful degradation, it is a hang.
    const result = resolveDevice(withEngine('accurate', 'auto'), hardware());

    expect(result.device).toBe('cpu');
    expect(result.profile).toBe('fast');
    expect(result.fallbackReason).toContain('Accurate profile needs a GPU');
  });

  it('explains an explicit GPU request that could not be met', () => {
    const result = resolveDevice(withEngine('fast', 'gpu'), hardware());

    expect(result.device).toBe('cpu');
    expect(result.fallbackReason).toContain('Falling back to the CPU');
    expect(result.fallbackReason).toContain('no-nvidia-driver');
  });

  it('honours an explicit CPU choice even when a GPU is available', () => {
    expect(resolveDevice(withEngine('fast', 'cpu'), gpuAvailable).device).toBe('cpu');
  });

  it('reports no fallback reason when Fast on CPU is what was asked for', () => {
    // Nothing was overridden, so there is nothing to explain.
    expect(resolveDevice(withEngine('fast', 'cpu'), gpuAvailable).fallbackReason).toBeNull();
  });

  it('still demotes the profile when CPU is chosen explicitly with Accurate', () => {
    const result = resolveDevice(withEngine('accurate', 'cpu'), gpuAvailable);

    expect(result.profile).toBe('fast');
    expect(result.fallbackReason).toContain('needs a GPU');
  });

  it('stays quiet when auto lands on the CPU and nothing was overridden', () => {
    // A CPU-only machine running the Fast profile got exactly what it asked for. Annotating
    // every one of those jobs with a "fallback" note is noise that trains users to ignore
    // the field entirely.
    expect(resolveDevice(withEngine('fast', 'auto'), hardware()).fallbackReason).toBeNull();
  });
});

describe('isPipelineEligible', () => {
  const ready = { globallyPaused: false, now: new Date(), runtimeReady: true };

  it('allows an enabled pipeline with the runtime installed', () => {
    expect(isPipelineEligible(pipeline(), ready).eligible).toBe(true);
  });

  it('blocks everything while globally paused', () => {
    const result = isPipelineEligible(pipeline(), { ...ready, globallyPaused: true });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('All pipelines are paused');
  });

  it('blocks a disabled pipeline', () => {
    expect(isPipelineEligible(pipeline({ enabled: false }), ready).reason).toContain(
      'This pipeline is paused',
    );
  });

  it('blocks when the runtime is not installed', () => {
    expect(isPipelineEligible(pipeline(), { ...ready, runtimeReady: false }).reason).toContain(
      'runtime is not installed',
    );
  });

  it('blocks outside the active hours and names the window', () => {
    const base = pipeline();
    const scheduled: Pipeline = {
      ...base,
      options: {
        ...base.options,
        schedule: {
          ...base.options.schedule,
          activeHoursEnabled: true,
          activeFrom: '18:00',
          activeUntil: '07:00',
        },
      },
    };

    const result = isPipelineEligible(scheduled, {
      ...ready,
      now: new Date(2026, 7, 19, 12, 0),
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('18:00');
  });
});

describe('isWithinActiveHours', () => {
  const overnight = { activeFrom: '18:00', activeUntil: '07:00' };
  const daytime = { activeFrom: '09:00', activeUntil: '17:00' };

  it('handles a window that wraps past midnight', () => {
    // The headline use case: "run overnight so it does not hog the GPU during work hours".
    expect(isWithinActiveHours(overnight, new Date(2026, 7, 19, 23, 0))).toBe(true);
    expect(isWithinActiveHours(overnight, new Date(2026, 7, 19, 3, 0))).toBe(true);
    expect(isWithinActiveHours(overnight, new Date(2026, 7, 19, 12, 0))).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(isWithinActiveHours(daytime, new Date(2026, 7, 19, 12, 0))).toBe(true);
    expect(isWithinActiveHours(daytime, new Date(2026, 7, 19, 8, 0))).toBe(false);
  });

  it('includes the start minute and excludes the end minute', () => {
    expect(isWithinActiveHours(daytime, new Date(2026, 7, 19, 9, 0))).toBe(true);
    expect(isWithinActiveHours(daytime, new Date(2026, 7, 19, 17, 0))).toBe(false);
  });

  it('treats a zero-length window as always active rather than never', () => {
    // "From 09:00 until 09:00" almost certainly means "no restriction", and reading it as
    // "never run" would silently stop a pipeline forever.
    expect(isWithinActiveHours({ activeFrom: '09:00', activeUntil: '09:00' }, new Date())).toBe(
      true,
    );
  });
});

describe('nextAttemptAt', () => {
  const now = new Date(2026, 7, 19, 12, 0, 0);

  it('waits the base delay after the first failure', () => {
    expect(nextAttemptAt(1, 30_000, now).getTime() - now.getTime()).toBe(30_000);
  });

  it('doubles with each further attempt', () => {
    expect(nextAttemptAt(2, 30_000, now).getTime() - now.getTime()).toBe(60_000);
    expect(nextAttemptAt(3, 30_000, now).getTime() - now.getTime()).toBe(120_000);
  });

  it('caps the delay so a dead share does not push retries days out', () => {
    expect(nextAttemptAt(20, 30_000, now).getTime() - now.getTime()).toBe(MAX_RETRY_DELAY_MS);
  });
});

describe('canRetry', () => {
  it('retries a transient failure while attempts remain', () => {
    expect(canRetry(1, 3, true)).toBe(true);
  });

  it('stops once the attempt limit is reached', () => {
    expect(canRetry(3, 3, true)).toBe(false);
  });

  it('never retries a non-retryable failure', () => {
    // A corrupt PDF will still be corrupt in 30 seconds; retrying only blocks the queue.
    expect(canRetry(1, 3, false)).toBe(false);
  });
});

describe('deviceCapacity', () => {
  it('allows a single GPU job so the model is not loaded twice', () => {
    expect(deviceCapacity(gpuAvailable).gpu).toBe(1);
  });

  it('reports no GPU capacity when none qualifies', () => {
    expect(deviceCapacity(hardware()).gpu).toBe(0);
  });

  it('leaves CPU headroom so the UI stays responsive', () => {
    expect(deviceCapacity(hardware({ cpuCores: 8 })).cpu).toBe(4);
  });

  it('always allows at least one CPU job', () => {
    expect(deviceCapacity(hardware({ cpuCores: 1 })).cpu).toBe(1);
  });
});
