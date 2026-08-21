// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpus } from 'node:os';

/**
 * Whether this machine can run the OCR engine natively, or is emulating.
 *
 * The distinction that matters is **not** ARM versus x86. PaddlePaddle 3.3.1 publishes
 * exactly three wheel platforms:
 *
 *     macosx_11_0_arm64      native Apple Silicon
 *     manylinux1_x86_64      Linux on x86-64
 *     win_amd64              Windows on x86-64
 *
 * So Apple Silicon is a first-class native target, and ARM as a category is fine. What has no
 * wheel is **Windows on ARM** — and Linux on ARM. There, the x86-64 build runs under
 * emulation, and emulation is where this falls apart: oneDNN raising
 * `ConvertPirAttribute2RuntimeAttribute`, inference dying with no traceback at all, and a
 * five-page scan taking longer than a coffee break.
 *
 * Detecting it up front is worth doing because every symptom of it looks like a bug in this
 * application rather than a platform that cannot support the workload.
 */

export type PlatformSupport = 'native' | 'emulated' | 'unsupported';

export interface PlatformReport {
  support: PlatformSupport;
  /** Plain-language explanation, shown in the UI. Empty when native. */
  reason: string;
}

export interface PlatformInputs {
  /** `process.platform`. */
  platform: string;
  /** `process.arch` — reports the *binary*, so 'x64' even on an ARM host under emulation. */
  arch: string;
  /**
   * `PROCESSOR_ARCHITEW6432`.
   *
   * Kept because it costs nothing, but **it is not set by Prism**. Measured on a Snapdragon X
   * running the x64 build: `PROCESSOR_ARCHITECTURE=AMD64` and `PROCESSOR_ARCHITEW6432`
   * undefined — indistinguishable from a real x86-64 box. It is a WOW64 (32-on-64) signal,
   * not an ARM-emulation one, and relying on it alone reported this very machine as native.
   */
  processorArchitew6432?: string | undefined;
  /** `PROCESSOR_ARCHITECTURE`, the architecture the process believes it is. */
  processorArchitecture?: string | undefined;
  /**
   * `os.cpus()[0].model`.
   *
   * The signal that actually works. Windows reports the true silicon here even to an emulated
   * process — "Snapdragon(R) X 12-core X1E80100" — where every architecture variable claims
   * AMD64.
   */
  cpuModel?: string | undefined;
}

/**
 * CPU vendors and families that are ARM, however the OS describes the architecture.
 *
 * A list of names is unlovely, but it is the only thing on Windows that distinguishes an
 * emulated process from a native one without a native module.
 */
const ARM_CPU_MARKERS = ['snapdragon', 'qualcomm', 'cortex', 'ampere', 'graviton', 'apple m'];

export function describePlatform(inputs: PlatformInputs): PlatformReport {
  const hostArch = (
    inputs.processorArchitew6432 ??
    inputs.processorArchitecture ??
    inputs.arch
  ).toLowerCase();

  const model = (inputs.cpuModel ?? '').toLowerCase();
  const modelIsArm = ARM_CPU_MARKERS.some((marker) => model.includes(marker));

  // Either signal is enough. The architecture variables catch the cases Windows admits to;
  // the CPU model catches Prism, which does not.
  const hostIsArm = hostArch.includes('arm') || hostArch.includes('aarch64') || modelIsArm;
  const binaryIsX86 = inputs.arch === 'x64' || inputs.arch === 'ia32';

  // Apple Silicon: a native wheel exists, so this is a fully supported configuration.
  if (inputs.platform === 'darwin' && inputs.arch === 'arm64') {
    return { support: 'native', reason: '' };
  }

  if (hostIsArm && binaryIsX86) {
    return {
      support: 'emulated',
      reason:
        'This is an ARM machine running the x86-64 build under emulation, because ' +
        'PaddlePaddle publishes no ARM wheel for this operating system. OCR may be very ' +
        'slow, and can fail outright. An x86-64 machine, or a Mac with Apple Silicon, is ' +
        'the supported configuration.',
    };
  }

  if (hostIsArm && !binaryIsX86 && inputs.platform !== 'darwin') {
    return {
      support: 'unsupported',
      reason:
        'PaddlePaddle publishes no ARM wheel for this operating system. Only macOS on ' +
        'Apple Silicon, and x86-64 elsewhere, can run the OCR engine.',
    };
  }

  return { support: 'native', reason: '' };
}

/** Read the current process's platform, for the composition root. */
export function describeCurrentPlatform(): PlatformReport {
  return describePlatform({
    platform: process.platform,
    arch: process.arch,
    processorArchitew6432: process.env.PROCESSOR_ARCHITEW6432,
    processorArchitecture: process.env.PROCESSOR_ARCHITECTURE,
    cpuModel: cpus()[0]?.model,
  });
}
