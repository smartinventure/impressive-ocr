// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { HardwareCapabilities } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { vlQuantiserPath, vlServerPaths } from '../../infra/paths';
import {
  MODEL_ASSETS,
  QUANTISATION,
  selectVlServerBuild,
  type VlServerBuild,
} from '../ocr/vl-server-index';

/**
 * Installs `llama-server` and the weights the accurate profile runs on.
 *
 * Separate from `runtime-installer.ts` because it shares nothing with it: that one drives
 * `uv` and pip, this one fetches release archives and runs a quantiser. The only thing they
 * have in common is the progress callback.
 *
 * The weights are downloaded at BF16 and quantised here rather than fetched pre-quantised.
 * That costs about four seconds, once, and means the only weights we ever ship are the ones
 * PaddlePaddle published — no third-party conversion to take on trust.
 */

const run = promisify(execFile);

export interface VlServerInstallOptions {
  vlServerDir: string;
  hardware: HardwareCapabilities;
  onMessage: (message: string) => void;
  signal?: AbortSignal | undefined;
  logger: Logger;
}

export async function installVlServer(options: VlServerInstallOptions): Promise<void> {
  const { vlServerDir, hardware, onMessage, signal, logger } = options;
  const build = selectVlServerBuild(hardware);
  const binDir = join(vlServerDir, 'bin');

  logger.info(
    { accelerator: build.accelerator, assets: build.assets.length },
    'Installing the inference server',
  );

  // Start from nothing. A half-finished previous attempt is the one state that looks valid
  // to `isInstalled` and fails at runtime, which is the worst of both.
  await rm(vlServerDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });

  await installBinaries(build, binDir, onMessage, signal, logger);
  await installWeights(vlServerDir, onMessage, signal);
  await quantise(vlServerDir, onMessage, signal, logger);
}

/**
 * Extract every archive into one flat `bin/`.
 *
 * Windows CUDA is two archives -- the server, and the CUDA runtime DLLs, which llama.cpp
 * publishes separately and without which nothing starts. They must land side by side.
 */
async function installBinaries(
  build: VlServerBuild,
  binDir: string,
  onMessage: (message: string) => void,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<void> {
  for (const [index, asset] of build.assets.entries()) {
    onMessage(`Downloading ${build.description} (${index + 1}/${build.assets.length})`);
    const archive = join(binDir, basename(asset));
    await download(asset, archive, signal);
    await extract(archive, binDir, logger);
    await rm(archive, { force: true });
  }

  // llama.cpp's archives are not consistently laid out: some put the executables at the root,
  // others under `build/bin`. Flatten rather than guess, so `vlServerPaths` stays simple.
  await flatten(binDir);
}

async function installWeights(
  vlServerDir: string,
  onMessage: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  onMessage('Downloading the OCR language model (1.7 GB)');
  await download(MODEL_ASSETS.weights, join(vlServerDir, 'model-bf16.gguf'), signal);

  onMessage('Downloading the vision encoder');
  await download(MODEL_ASSETS.projector, join(vlServerDir, 'mmproj.gguf'), signal);
  await download(MODEL_ASSETS.chatTemplate, join(vlServerDir, 'chat_template.jinja'), signal);
}

/**
 * Convert BF16 to Q5_K_M and delete the original.
 *
 * Measured at ~4 s and 20% faster inference afterwards, for 0.2 points of word accuracy --
 * the best point on that curve; Q4 gives up 0.8 points to save another 0.09 s/page. The
 * vision encoder is deliberately left alone: it is the larger half of the working set but
 * quantising it costs accuracy where it is least recoverable.
 */
async function quantise(
  vlServerDir: string,
  onMessage: (message: string) => void,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<void> {
  const source = join(vlServerDir, 'model-bf16.gguf');
  const target = vlServerPaths(vlServerDir, QUANTISATION).model;

  onMessage('Optimising the model for this machine');
  const started = Date.now();
  await run(vlQuantiserPath(vlServerDir), [source, target, QUANTISATION], {
    signal,
    maxBuffer: 8 * 1024 * 1024,
  });

  await rm(source, { force: true });
  logger.info({ ms: Date.now() - started, quantisation: QUANTISATION }, 'Model optimised');
}

/**
 * Stream a URL to disk.
 *
 * Streamed rather than buffered: these are up to 900 MB each, and holding one in memory on a
 * 16 GB laptop while Paddle is also resident is how an install becomes a swap storm.
 */
async function download(
  url: string,
  destination: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await fetch(url, { signal: signal ?? null, redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed with status ${response.status}: ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/**
 * Unpack an archive using the system `tar`.
 *
 * No dependency needed: bsdtar ships with Windows 10 1803 and later and reads zip as well as
 * tar, and every Linux and macOS we support has tar for the `.tar.gz` builds. llama.cpp
 * publishes zip for Windows and tar.gz elsewhere, so one command covers both.
 *
 * Two Windows details, both learned the hard way:
 *
 * - **The absolute path to bsdtar, not `tar`.** A machine with Git for Windows on its PATH
 *   resolves `tar` to GNU tar, which cannot read zip at all. `System32\tar.exe` is the one
 *   that can.
 * - **Run inside the destination and name the archive relatively.** GNU tar reads `C:\...`
 *   as a `host:path` remote spec and tries to open a network connection — the same trap
 *   `deploy/package-server.mjs` works around. Staying relative sidesteps it whichever tar
 *   ends up being called.
 */
function systemTar(): string {
  if (process.platform !== 'win32') {
    return 'tar';
  }
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

async function extract(archive: string, destination: string, logger: Logger): Promise<void> {
  try {
    await run(systemTar(), ['-xf', basename(archive)], {
      cwd: destination,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    logger.error({ err: error, archive }, 'Could not extract the inference server archive');
    throw error;
  }
}

/**
 * Move every nested file up into `binDir`, then drop the empty directories.
 *
 * Recursive because the nesting depth varies between llama.cpp's archives -- some are flat,
 * some use `build/bin/`. Collect first and move afterwards, so the walk is not reading a
 * directory that is being rewritten underneath it.
 *
 * Exported for testing: if this puts `llama-server` anywhere other than `bin/`, the accurate
 * profile silently falls back to the slow backend on every machine, and the only symptom is
 * that it is slow.
 */
export async function flatten(binDir: string): Promise<void> {
  const nested: string[] = [];
  const files: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        nested.push(path);
        await walk(path);
      } else if (directory !== binDir) {
        files.push(path);
      }
    }
  };
  await walk(binDir);

  for (const file of files) {
    // Losing a duplicate is fine — the archives overlap on shared libraries — but losing the
    // executable is not, so a failed move is worth knowing about rather than swallowing.
    await rename(file, join(binDir, basename(file)));
  }
  // Deepest first, so a directory is always empty by the time it is removed.
  for (const directory of nested.reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
}
