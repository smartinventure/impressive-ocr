// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoTimestampSchema } from './common';
import { engineProfileSchema } from './pipeline-options';

/** PaddleOCR needs Compute Capability >= 7.0 and CUDA >= 11.8; PaddleOCR-VL wants >= 8 GB VRAM. */
export const MIN_COMPUTE_CAPABILITY = 7.0;
export const MIN_VRAM_BYTES_FOR_VL = 8 * 1024 ** 3;

export const gpuInfoSchema = z.object({
  name: z.string(),
  vramBytes: z.number().int().min(0),
  computeCapability: z.number().min(0),
  driverVersion: z.string(),
});

export type GpuInfo = z.infer<typeof gpuInfoSchema>;

/**
 * Why the GPU cannot be used. Surfaced verbatim in the UI — a user who bought a GPU deserves
 * to know it is a 4 GB card rather than a silent fallback to CPU.
 */
export const gpuUnavailableReasonSchema = z.enum([
  'no-nvidia-driver',
  'no-gpu-detected',
  'compute-capability-too-low',
  'insufficient-vram',
  'probe-failed',
  'unsupported-platform',
]);
export type GpuUnavailableReason = z.infer<typeof gpuUnavailableReasonSchema>;

export const hardwareCapabilitiesSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int().min(1),
  totalMemoryBytes: z.number().int().min(0),
  gpu: gpuInfoSchema.nullable(),
  gpuUnavailableReason: gpuUnavailableReasonSchema.nullable(),
  /** True only when a GPU exists *and* clears the thresholds above. */
  canUseGpu: z.boolean(),
  /** Profiles this machine can actually run; `accurate` requires a qualifying GPU. */
  availableProfiles: z.array(engineProfileSchema),
  probedAt: isoTimestampSchema,
});

export type HardwareCapabilities = z.infer<typeof hardwareCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Python runtime bootstrap
// ---------------------------------------------------------------------------

export const runtimeStateSchema = z.enum([
  'not-installed',
  'installing',
  'ready',
  'failed',
  'outdated',
]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

export const runtimeStepSchema = z.enum([
  'probe-hardware',
  'install-python',
  'create-venv',
  'install-paddle',
  'install-paddleocr',
  'download-models',
  'verify',
]);
export type RuntimeStep = z.infer<typeof runtimeStepSchema>;

export const runtimeStatusSchema = z.object({
  state: runtimeStateSchema,
  /** Null unless state is `installing`. */
  currentStep: runtimeStepSchema.nullable(),
  /** 0–100 across the whole install, not just the current step. */
  progressPercent: z.number().min(0).max(100),
  message: z.string().max(500),
  pythonVersion: z.string().nullable(),
  paddleVersion: z.string().nullable(),
  paddleocrVersion: z.string().nullable(),
  /** `paddlepaddle` or `paddlepaddle-gpu`, recorded so we can detect a hardware change later. */
  paddleFlavor: z.enum(['cpu', 'gpu']).nullable(),
  errorMessage: z.string().max(2000).nullable(),
});

export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const sidecarHealthSchema = z.object({
  id: z.string(),
  pid: z.number().int().nullable(),
  device: z.enum(['gpu', 'cpu']),
  profile: engineProfileSchema,
  state: z.enum(['starting', 'ready', 'busy', 'unhealthy', 'stopped']),
  restarts: z.number().int().min(0),
  lastHeartbeatAt: isoTimestampSchema.nullable(),
});

export type SidecarHealth = z.infer<typeof sidecarHealthSchema>;

export const systemStatusSchema = z.object({
  appVersion: z.string(),
  hardware: hardwareCapabilitiesSchema,
  runtime: runtimeStatusSchema,
  sidecars: z.array(sidecarHealthSchema),
  /** Global pause switch — overrides every pipeline's own enabled flag. */
  globallyPaused: z.boolean(),
  uptimeSeconds: z.number().min(0),
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;
