// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  formatVramGib,
  MIN_VRAM_GIB_FOR_VL,
  type EngineProfile,
  type HardwareCapabilities,
  type Pipeline,
  type ResolvedDevice,
} from '@impressive-ocr/shared';

/**
 * The decisions the scheduler makes, as pure functions.
 *
 * Kept free of the database, the clock and the sidecar pool so every rule here can be tested
 * directly. These are exactly the rules that are painful to debug once they are entangled
 * with IO: why a pipeline will not start, why a job went to the CPU, when a retry is due.
 */

export interface DeviceResolution {
  device: ResolvedDevice;
  profile: EngineProfile;
  /** Set when the user's preference could not be honoured. Surfaced on the job. */
  fallbackReason: string | null;
}

/**
 * Decide which device and engine profile a job actually runs on.
 *
 * `auto` is not "prefer GPU": the Accurate profile is a 0.9B vision-language model that is
 * unusably slow on a CPU, so falling back has to change the *profile* too, not just the
 * device. Silently running Accurate on a CPU would look like a hang.
 */
export function resolveDevice(
  pipeline: Pipeline,
  hardware: HardwareCapabilities,
): DeviceResolution {
  const { profile, device } = pipeline.options.engine;

  if ((device === 'gpu' || device === 'auto') && hardware.canUseGpu) {
    // A card can be perfectly good for the Fast pipeline and still too small for the 0.9B
    // VLM. That downgrades the profile, not the device: running Fast on the GPU is what the
    // user wanted second-best, and dropping to the CPU as well would be a needless penalty.
    if (profile === 'accurate' && !hardware.availableProfiles.includes('accurate')) {
      return {
        device: 'gpu',
        profile: 'fast',
        fallbackReason: `${describeVlShortfall(hardware)} The Fast profile was used on the GPU instead.`,
      };
    }
    return { device: 'gpu', profile, fallbackReason: null };
  }

  // Everything below lands on the CPU. Explain it only where the outcome differs from what
  // the user asked for — a "fallback" note on every job of a CPU-only machine that asked
  // for Fast on CPU would be pure noise, and noise is how real warnings get ignored.
  const parts: string[] = [];

  if (device === 'gpu') {
    parts.push(`${describeUnavailableGpu(hardware)} Falling back to the CPU.`);
  }
  // The Accurate profile runs on a CPU now, but only through the batching inference engine.
  // Without it PaddleOCR recognises one layout region at a time, which on a CPU is not slow
  // so much as stalled -- so its absence, not the missing GPU, is what forces Fast here.
  if (profile === 'accurate' && !hardware.canRunAccurateOnCpu) {
    if (parts.length === 0 && device === 'auto') {
      parts.push(describeUnavailableGpu(hardware));
    }
    parts.push(
      'The Accurate profile needs the fast inference engine to run on a CPU; the Fast profile was used instead.',
    );
    return { device: 'cpu', profile: 'fast', fallbackReason: parts.join(' ') };
  }

  return {
    device: 'cpu',
    profile,
    fallbackReason: parts.length > 0 ? parts.join(' ') : null,
  };
}

function describeVlShortfall(hardware: HardwareCapabilities): string {
  const gpu = hardware.gpu;
  return gpu === null
    ? `The Accurate profile needs a ${MIN_VRAM_GIB_FOR_VL} GB card or larger.`
    : `The Accurate profile needs a ${MIN_VRAM_GIB_FOR_VL} GB card or larger; ${gpu.name} has ${formatVramGib(gpu.vramBytes)}.`;
}

function describeUnavailableGpu(hardware: HardwareCapabilities): string {
  return hardware.gpuUnavailableReason === null
    ? 'No GPU is available.'
    : `GPU unavailable (${hardware.gpuUnavailableReason}).`;
}

/**
 * Whether a pipeline may start work right now.
 *
 * Split from `resolveDevice` because the reasons are user-facing: the overview screen shows
 * "blocked" with this exact explanation, and "nothing is happening and I do not know why" is
 * the worst possible state for a background processor.
 */
export interface EligibilityResult {
  eligible: boolean;
  reason: string | null;
}

export function isPipelineEligible(
  pipeline: Pipeline,
  options: { globallyPaused: boolean; now: Date; runtimeReady: boolean },
): EligibilityResult {
  if (options.globallyPaused) {
    return { eligible: false, reason: 'All pipelines are paused.' };
  }
  if (!pipeline.enabled) {
    return { eligible: false, reason: 'This pipeline is paused.' };
  }
  if (!options.runtimeReady) {
    return { eligible: false, reason: 'The OCR runtime is not installed yet.' };
  }

  const schedule = pipeline.options.schedule;
  if (schedule.activeHoursEnabled && !isWithinActiveHours(schedule, options.now)) {
    return {
      eligible: false,
      reason: `Outside the active hours (${schedule.activeFrom}–${schedule.activeUntil}).`,
    };
  }
  return { eligible: true, reason: null };
}

/**
 * Is `now` inside the configured window?
 *
 * The window routinely wraps past midnight — "run overnight, 18:00 to 07:00" is the whole
 * point of the feature — so a naive `from <= now && now <= until` comparison would be wrong
 * for the common case.
 */
export function isWithinActiveHours(
  schedule: { activeFrom: string; activeUntil: string },
  now: Date,
): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = parseMinutes(schedule.activeFrom);
  const until = parseMinutes(schedule.activeUntil);

  if (from === until) {
    return true; // A zero-length window is treated as "always", not "never".
  }
  return from < until ? current >= from && current < until : current >= from || current < until;
}

function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number.parseInt(hours ?? '0', 10) * 60 + Number.parseInt(minutes ?? '0', 10);
}

/**
 * When a failed job may be tried again.
 *
 * Exponential with a cap: a locked file usually frees within seconds, but a full disk or a
 * dead network share will not, and hammering it every 30 seconds fills the log without
 * helping anyone.
 */
export const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

export function nextAttemptAt(attempt: number, baseDelayMs: number, now: Date): Date {
  const exponent = Math.max(0, attempt - 1);
  const delay = Math.min(baseDelayMs * 2 ** exponent, MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delay);
}

/** Whether the job has attempts left, given the pipeline's limit. */
export function canRetry(attempts: number, maxAttempts: number, retryable: boolean): boolean {
  return retryable && attempts < maxAttempts;
}

/**
 * How many jobs may run at once on each device.
 *
 * The GPU lane is fixed at one while a vision-language model holds several gigabytes of
 * VRAM — a second concurrent job would not go faster, it would go out of memory.
 */
/**
 * How many documents may be in flight per device.
 *
 * **Memory, not cores.** This used to return `cpuCores / 2`, which on a 12-core laptop meant
 * six concurrent documents — and each one is a separate sidecar holding its own warm
 * PP-StructureV3 model set, roughly 2-4 GB. Six of those is 12-24 GB on a 16 GB machine, so
 * it swapped: memory pegged at 97%, CPU down at 10-30% because everything was waiting on the
 * disk, and a five-page document sat on page 0 for ten minutes.
 *
 * The limit is therefore what the user configured, defaulting to one. Cores decide how fast a
 * single document is OCR'd (via the thread cap in the sidecar); they do not decide how many
 * model sets fit in RAM.
 */
export function deviceCapacity(
  hardware: HardwareCapabilities,
  maxConcurrentDocuments: number,
): Record<ResolvedDevice, number> {
  const limit = Math.max(1, maxConcurrentDocuments);
  return {
    // The VLM holds VRAM for its whole lifetime, so the GPU lane has always been one.
    gpu: hardware.canUseGpu ? 1 : 0,
    cpu: limit,
  };
}
