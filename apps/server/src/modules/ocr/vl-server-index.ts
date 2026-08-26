// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HardwareCapabilities } from '@impressive-ocr/shared';

/**
 * Chooses which `llama-server` build and model weights the accurate profile needs.
 *
 * The engine is PaddleOCR-VL either way — this only decides how it is *driven*. PaddleOCR's
 * own backend recognises one layout region at a time, which is why a dense page costs about a
 * minute; the same weights behind a server that batches those regions take ~2 s on a GPU and
 * ~11 s on a CPU. So this is not "which model", it is "which runtime", and the accuracy is
 * identical whichever row is selected.
 *
 * Pure and hardware-driven, like `runtime/wheel-index.ts`: the installer asks what to fetch,
 * and every answer is testable without touching the network.
 */

/** PaddleOCR's name for the client that talks to `llama-server`. Not a free-form string. */
export const LLAMA_CPP_BACKEND = 'llama-cpp-server';

/** Pinned. A newer build can change flags and quantisation formats under us. */
export const LLAMA_CPP_BUILD = 'b10630';

export type VlAccelerator = 'cuda' | 'vulkan' | 'metal' | 'cpu';

export interface VlServerBuild {
  accelerator: VlAccelerator;
  /** Release assets to download, in order. Windows CUDA needs the runtime DLLs separately. */
  assets: readonly string[];
  /** Shown before the download, which is most of a gigabyte. */
  description: string;
  archiveBytes: number;
}

const RELEASE_BASE = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_BUILD}`;

/**
 * The official GGUF conversion, from PaddlePaddle's own account. Apache-2.0, and the only
 * quantisation we trust: it is converted here from these exact BF16 weights rather than
 * downloaded pre-quantised from a third party.
 *
 * `mmproj` is the vision encoder and is **not** quantised — at 841 MB it is the larger half
 * of the working set, which is why quantising the language model only buys ~20%.
 */
const MODEL_BASE = 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main';

export const MODEL_ASSETS = {
  weights: `${MODEL_BASE}/PaddleOCR-VL-1.6-GGUF.gguf`,
  projector: `${MODEL_BASE}/PaddleOCR-VL-1.6-GGUF-mmproj.gguf`,
  chatTemplate: `${MODEL_BASE}/chat_template.jinja`,
} as const;

/** Downloaded at BF16, quantised on the machine, and the original deleted. */
export const QUANTISATION = 'Q5_K_M';

/**
 * Measured 2026-08-26. BF16 weights 892 MB plus the 841 MB projector; the quantised result
 * is 326 MB, so the install peaks well above what it finally occupies.
 */
export const MODEL_DOWNLOAD_BYTES = 1733 * 1024 ** 2;

/**
 * CUDA 12.4 rather than the newer 13.x builds.
 *
 * The driver reports the highest CUDA it supports, and a 13.x build refuses to load on a
 * driver below it. 12.4 runs on every driver that satisfies the PaddlePaddle wheels we
 * already require, so it is the one that cannot strand a working machine.
 */
const WINDOWS_CUDA: VlServerBuild = {
  accelerator: 'cuda',
  assets: [
    `${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-win-cuda-12.4-x64.zip`,
    // Shipped separately by llama.cpp, and the server will not start without it.
    `${RELEASE_BASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
  ],
  description: 'llama.cpp (NVIDIA CUDA)',
  archiveBytes: 642 * 1024 ** 2,
};

const WINDOWS_CPU: VlServerBuild = {
  accelerator: 'cpu',
  assets: [`${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-win-cpu-x64.zip`],
  description: 'llama.cpp (CPU)',
  archiveBytes: 40 * 1024 ** 2,
};

/**
 * Vulkan, not CUDA — llama.cpp publishes **no Linux CUDA binary**.
 *
 * Its Linux releases are CPU, Vulkan, ROCm, SYCL and OpenVINO; CUDA is Windows-only. Vulkan
 * runs on NVIDIA cards and is far closer to CUDA than to the CPU path, so it is what a Linux
 * GPU machine gets. Where the Vulkan driver is missing the server fails to start and the pool
 * falls back to the native backend, which is the same path any other startup failure takes.
 */
const LINUX_GPU: VlServerBuild = {
  accelerator: 'vulkan',
  assets: [`${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`],
  description: 'llama.cpp (Vulkan)',
  archiveBytes: 60 * 1024 ** 2,
};

const LINUX_CPU: VlServerBuild = {
  accelerator: 'cpu',
  assets: [`${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-ubuntu-x64.tar.gz`],
  description: 'llama.cpp (CPU)',
  archiveBytes: 40 * 1024 ** 2,
};

/** Apple Silicon. Metal is compiled in, so there is no separate accelerated build to pick. */
const MACOS_METAL: VlServerBuild = {
  accelerator: 'metal',
  assets: [`${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-macos-arm64.tar.gz`],
  description: 'llama.cpp (Apple Metal)',
  archiveBytes: 40 * 1024 ** 2,
};

const MACOS_INTEL: VlServerBuild = {
  accelerator: 'cpu',
  assets: [`${RELEASE_BASE}/llama-${LLAMA_CPP_BUILD}-bin-macos-x64.tar.gz`],
  description: 'llama.cpp (CPU)',
  archiveBytes: 40 * 1024 ** 2,
};

/**
 * Which build this machine needs.
 *
 * `canUseGpu` rather than "is there a card": the hardware probe has already decided whether
 * the driver and memory are usable, and second-guessing it here would let the two disagree.
 * A machine without one still gets a build — CPU is a supported way to run this profile now,
 * not a failure case.
 */
export function selectVlServerBuild(hardware: HardwareCapabilities): VlServerBuild {
  if (hardware.platform === 'darwin') {
    return hardware.arch === 'arm64' ? MACOS_METAL : MACOS_INTEL;
  }
  if (hardware.platform === 'win32') {
    return hardware.canUseGpu ? WINDOWS_CUDA : WINDOWS_CPU;
  }
  return hardware.canUseGpu ? LINUX_GPU : LINUX_CPU;
}

/** Total bytes the `download-vl-server` step will fetch, for the confirmation shown first. */
export function vlServerDownloadBytes(build: VlServerBuild): number {
  return build.archiveBytes + MODEL_DOWNLOAD_BYTES;
}
