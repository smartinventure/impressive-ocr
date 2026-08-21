// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoTimestampSchema } from './common';
import { engineProfileSchema } from './pipeline-options';

/** PaddleOCR needs Compute Capability >= 7.0 and CUDA >= 11.8. */
export const MIN_COMPUTE_CAPABILITY = 7.0;

/**
 * Two VRAM floors, not one, because they answer different questions.
 *
 * Using the GPU at all is a far smaller ask than running the Accurate profile. PP-StructureV3
 * with this app's default modules fits on a 4 GB card; PaddleOCR-VL-0.9B is documented as
 * wanting "GPU Memory: 8GB or more". Conflating the two meant an 8 GB machine was told it had
 * no usable GPU, installed the CPU-only wheel, and never touched the card for any profile.
 */
export const MIN_VRAM_GIB_FOR_GPU = 4;
export const MIN_VRAM_GIB_FOR_VL = 8;

/**
 * `nvidia-smi` reports *usable* VRAM, which is always a little under the nominal size: an
 * "8 GB" RTX 4060 Ti reports 8188 MiB — four short of 8192. Comparing against a whole 8 GiB
 * therefore rejects every 8 GB card ever built, which is precisely the class the requirement
 * means to admit. Thresholds are the card class minus this slack.
 */
const CARD_CLASS_SLACK_BYTES = 256 * 1024 ** 2;

export const MIN_VRAM_BYTES_FOR_GPU = MIN_VRAM_GIB_FOR_GPU * 1024 ** 3 - CARD_CLASS_SLACK_BYTES;
export const MIN_VRAM_BYTES_FOR_VL = MIN_VRAM_GIB_FOR_VL * 1024 ** 3 - CARD_CLASS_SLACK_BYTES;

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
  /** True when a GPU exists and clears the compute, driver and `MIN_VRAM_GIB_FOR_GPU` bars. */
  canUseGpu: z.boolean(),
  /** Profiles this machine can actually run; `accurate` additionally needs the VL floor. */
  availableProfiles: z.array(engineProfileSchema),
  probedAt: isoTimestampSchema,
});

export type HardwareCapabilities = z.infer<typeof hardwareCapabilitiesSchema>;

/**
 * Whether this card can host PaddleOCR-VL, which is a stricter bar than using the GPU at all.
 *
 * Separate from `canUseGpu` on purpose: a 4 GB card runs the Fast profile on the GPU perfectly
 * well and must not be demoted to the CPU merely because the VL model would not fit.
 */
export function supportsAccurateProfile(gpu: GpuInfo | null): boolean {
  return gpu !== null && gpu.vramBytes >= MIN_VRAM_BYTES_FOR_VL;
}

/** VRAM as the user's card is sold and labelled: "8.0 GB". */
export function formatVramGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Python runtime bootstrap
// ---------------------------------------------------------------------------

/**
 * What an install is about to do, so it can be confirmed before it starts.
 *
 * The CPU and GPU builds differ by most of a gigabyte, and the choice between them is made
 * from a hardware probe the user never sees. Downloading that much on somebody's metered
 * connection without saying so first is not acceptable.
 */
export const runtimeInstallPlanSchema = z.object({
  flavor: z.enum(['cpu', 'gpu']),
  packageName: z.string(),
  /** "PaddlePaddle GPU (bundled CUDA 12.9)" — what is actually being fetched. */
  description: z.string(),
  /** Why this build was chosen, in one sentence. */
  rationale: z.string(),
  downloadBytes: z.number().int().min(0),
  installedBytes: z.number().int().min(0),
  targetPath: z.string(),
  freeBytes: z.number().int().min(0).nullable(),
  enoughSpace: z.boolean(),
});

export type RuntimeInstallPlan = z.infer<typeof runtimeInstallPlanSchema>;

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
