// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GpuInfo, HardwareCapabilities } from '@impressive-ocr/shared';

/**
 * Chooses which PaddlePaddle build to install.
 *
 * PaddlePaddle publishes GPU wheels from its own index, one per CUDA version, and each wheel
 * **bundles CUDA and cuDNN**. So the choice here is not "which CUDA does the user have"
 * — it is "which bundled CUDA does the user's *driver* support", which is a much easier
 * question and the reason the installer never has to run NVIDIA's own installer.
 */

export type PaddleFlavor = 'cpu' | 'gpu';

export interface WheelSelection {
  flavor: PaddleFlavor;
  packageName: 'paddlepaddle' | 'paddlepaddle-gpu';
  /** Extra pip index for GPU builds; undefined means plain PyPI. */
  indexUrl: string | undefined;
  /** Shown in the setup wizard so the user knows what is being downloaded. */
  description: string;
}

const PADDLE_INDEX_BASE = 'https://www.paddlepaddle.org.cn/packages/stable';

/**
 * Minimum NVIDIA driver version for each bundled CUDA runtime.
 *
 * CUDA minor-version compatibility means a driver only has to satisfy the *major* release,
 * so these are the documented floors for the CUDA 12.x and 11.x series.
 */
const CUDA_BUILDS = [
  { tag: 'cu129', cuda: '12.9', minDriverWindows: 527, minDriverLinux: 525 },
  { tag: 'cu126', cuda: '12.6', minDriverWindows: 527, minDriverLinux: 525 },
  { tag: 'cu118', cuda: '11.8', minDriverWindows: 452, minDriverLinux: 450 },
] as const;

export const CPU_SELECTION: WheelSelection = {
  flavor: 'cpu',
  packageName: 'paddlepaddle',
  indexUrl: undefined,
  description: 'PaddlePaddle (CPU)',
};

export function selectWheel(hardware: HardwareCapabilities): WheelSelection {
  if (!hardware.canUseGpu || hardware.gpu === null) {
    return CPU_SELECTION;
  }
  const build = selectCudaBuild(hardware.gpu, hardware.platform);
  if (build === null) {
    // A qualifying card behind a driver too old for any bundled CUDA. Falling back to CPU
    // beats a multi-gigabyte download that cannot possibly load.
    return CPU_SELECTION;
  }
  return {
    flavor: 'gpu',
    packageName: 'paddlepaddle-gpu',
    indexUrl: `${PADDLE_INDEX_BASE}/${build.tag}/`,
    description: `PaddlePaddle GPU (bundled CUDA ${build.cuda})`,
  };
}

/** Newest bundled CUDA the installed driver can run, or null if even the oldest is too new. */
export function selectCudaBuild(
  gpu: GpuInfo,
  platform: HardwareCapabilities['platform'],
): (typeof CUDA_BUILDS)[number] | null {
  const driverMajor = parseDriverMajor(gpu.driverVersion);
  if (driverMajor === null) {
    // Unknown driver version: take the most conservative build that still works.
    return CUDA_BUILDS[CUDA_BUILDS.length - 1] ?? null;
  }
  for (const build of CUDA_BUILDS) {
    const minimum = platform === 'win32' ? build.minDriverWindows : build.minDriverLinux;
    if (driverMajor >= minimum) {
      return build;
    }
  }
  return null;
}

function parseDriverMajor(driverVersion: string): number | null {
  const major = Number.parseInt(driverVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * The pip arguments that install the chosen build.
 *
 * `--index-url` rather than `--extra-index-url`: with an extra index, pip resolves across
 * both and can silently pull the CPU `paddlepaddle` from PyPI instead of the GPU build.
 */
export function pipInstallArgs(selection: WheelSelection, version?: string): string[] {
  const requirement =
    version === undefined ? selection.packageName : `${selection.packageName}==${version}`;
  const args = ['pip', 'install', '--upgrade', requirement];
  if (selection.indexUrl !== undefined) {
    args.push('--index-url', selection.indexUrl);
  }
  return args;
}
