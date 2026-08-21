// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { promisify } from 'node:util';
import {
  MIN_COMPUTE_CAPABILITY,
  MIN_VRAM_BYTES_FOR_VL,
  type GpuInfo,
  type GpuUnavailableReason,
  type HardwareCapabilities,
} from '@impressive-ocr/shared';

const run = promisify(execFile);

/**
 * Decides whether this machine can run the GPU profile.
 *
 * We do **not** check for a CUDA Toolkit install: `paddlepaddle-gpu` wheels bundle CUDA and
 * cuDNN, so the only host requirement is a recent NVIDIA driver. That is the whole reason
 * the installer does not need to ship or run the CUDA installer.
 *
 * Every rejection carries a reason, because "falls back to CPU" with no explanation is
 * indistinguishable from a bug to someone who just bought a graphics card.
 */

/** nvidia-smi occasionally hangs on a wedged driver; a probe must never block startup. */
const PROBE_TIMEOUT_MS = 5_000;

const QUERY_FIELDS = 'name,memory.total,compute_cap,driver_version';

export interface GpuProbeResult {
  gpu: GpuInfo | null;
  reason: GpuUnavailableReason | null;
}

export async function probeGpu(): Promise<GpuProbeResult> {
  if (process.platform === 'darwin') {
    // Apple Silicon has no CUDA. PaddleOCR runs on CPU there, and does so well.
    return { gpu: null, reason: 'unsupported-platform' };
  }

  let stdout: string;
  try {
    const result = await run(
      'nvidia-smi',
      [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader,nounits'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    );
    stdout = result.stdout;
  } catch (error) {
    // A missing binary means no NVIDIA driver; anything else means the driver is present
    // but unhealthy. The user can act on the difference.
    return { gpu: null, reason: isNotFound(error) ? 'no-nvidia-driver' : 'probe-failed' };
  }

  const gpus = parseGpuTable(stdout);
  if (gpus.length === 0) {
    return { gpu: null, reason: 'no-gpu-detected' };
  }

  // Pick the largest card: on a laptop with an integrated and a discrete GPU, the discrete
  // one is the only one worth using.
  const best = gpus.reduce((a, b) => (b.vramBytes > a.vramBytes ? b : a));

  if (best.computeCapability < MIN_COMPUTE_CAPABILITY) {
    return { gpu: best, reason: 'compute-capability-too-low' };
  }
  if (best.vramBytes < MIN_VRAM_BYTES_FOR_VL) {
    return { gpu: best, reason: 'insufficient-vram' };
  }
  return { gpu: best, reason: null };
}

/**
 * Parse `nvidia-smi --format=csv,noheader,nounits` output.
 *
 * Split out and exported so the parsing is testable without an NVIDIA machine — which
 * matters, since most development machines (including this one) have none.
 */
export function parseGpuTable(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [name, memoryMib, computeCap, driverVersion] = trimmed.split(',').map((v) => v.trim());
    if (name === undefined || memoryMib === undefined) {
      continue;
    }
    const memory = Number.parseFloat(memoryMib);
    if (!Number.isFinite(memory)) {
      continue;
    }
    gpus.push({
      name,
      // `nounits` reports memory.total in MiB.
      vramBytes: Math.round(memory * 1024 * 1024),
      computeCapability: Number.parseFloat(computeCap ?? '0') || 0,
      driverVersion: driverVersion ?? 'unknown',
    });
  }
  return gpus;
}

export async function probeHardware(): Promise<HardwareCapabilities> {
  const { gpu, reason } = await probeGpu();
  const canUseGpu = gpu !== null && reason === null;
  const cores = cpus();

  return {
    platform: normalizePlatform(process.platform),
    arch: process.arch,
    cpuModel: cores[0]?.model.trim() ?? 'unknown',
    cpuCores: cores.length || 1,
    totalMemoryBytes: totalmem(),
    gpu,
    gpuUnavailableReason: reason,
    canUseGpu,
    // The accurate profile is a 0.9B VLM: usable on a qualifying GPU, unusably slow on CPU,
    // so it is offered only when the GPU actually qualifies.
    availableProfiles: canUseGpu ? ['accurate', 'fast'] : ['fast'],
    probedAt: new Date().toISOString(),
  };
}

/** Human-readable explanation for the UI. Never leave the user guessing. */
export function describeGpuReason(reason: GpuUnavailableReason, gpu: GpuInfo | null): string {
  switch (reason) {
    case 'no-nvidia-driver':
      return 'No NVIDIA driver found. Install the latest NVIDIA driver to enable GPU processing — a separate CUDA Toolkit is not required.';
    case 'no-gpu-detected':
      return 'The NVIDIA driver is installed but reported no GPU.';
    case 'compute-capability-too-low':
      return `${gpu?.name ?? 'The GPU'} has compute capability ${gpu?.computeCapability ?? '?'}; PaddleOCR needs at least ${MIN_COMPUTE_CAPABILITY}.`;
    case 'insufficient-vram':
      return `${gpu?.name ?? 'The GPU'} has ${formatGib(gpu?.vramBytes ?? 0)} of VRAM; the Accurate profile needs at least ${formatGib(MIN_VRAM_BYTES_FOR_VL)}.`;
    case 'probe-failed':
      return 'nvidia-smi did not respond. The driver may need a restart.';
    case 'unsupported-platform':
      return 'CUDA is not available on this platform; processing runs on the CPU.';
  }
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function normalizePlatform(platform: NodeJS.Platform): 'win32' | 'darwin' | 'linux' {
  if (platform === 'win32' || platform === 'darwin') {
    return platform;
  }
  return 'linux';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
