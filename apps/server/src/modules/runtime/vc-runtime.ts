// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { exists } from '../../infra/fs/file-ops';

/**
 * Is the Microsoft Visual C++ runtime that PaddlePaddle links against installed?
 *
 * PaddlePaddle's own DLLs are built with MSVC and do not bundle the runtime. On a Windows
 * install that has never had a Visual C++ Redistributable — a fresh machine that has never
 * run a game or a desktop application built with MSVC — importing `paddle` fails with:
 *
 *     ImportError: DLL load failed while importing libpaddle: The specified module could
 *     not be found.
 *
 * which names neither the missing DLL nor the redistributable. Observed dependency chain:
 *
 *     libpaddle.pyd  ->  mkldnn.dll  ->  VCOMP140.DLL   (absent)
 *
 * `vcomp140.dll` is the OpenMP runtime and was the one actually missing; the others are
 * checked because the same redistributable supplies all of them and a partial set is a
 * reliable sign of a stale or damaged install.
 *
 * This is the *fixable* half of preflight: one download resolves it.
 */

export type VcRuntimeStatus = 'present' | 'missing' | 'not-applicable';

export interface VcRuntimeReport {
  status: VcRuntimeStatus;
  /** Exactly which DLLs were not found, so the message can name them. */
  missing: string[];
}

/**
 * Supplied by the Visual C++ 2015-2022 Redistributable (x64).
 *
 * `vcomp140.dll` first: it is the one that breaks PaddleOCR in practice, and listing it
 * first makes the log line read correctly when only it is absent.
 */
export const REQUIRED_VC_DLLS = [
  'vcomp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
] as const;

/** Where a redistributable install puts them, and the only location Windows always searches. */
function systemDirectory(systemRoot: string): string {
  return join(systemRoot, 'System32');
}

export async function probeVcRuntime(
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): Promise<VcRuntimeReport> {
  // macOS and Linux have no MSVC runtime; PaddlePaddle links against the platform libc there.
  if (platform !== 'win32') {
    return { status: 'not-applicable', missing: [] };
  }

  const directory = systemDirectory(systemRoot);
  const missing: string[] = [];
  for (const dll of REQUIRED_VC_DLLS) {
    if (!(await exists(join(directory, dll)))) {
      missing.push(dll);
    }
  }

  return { status: missing.length === 0 ? 'present' : 'missing', missing };
}

/** Microsoft's permanent redirect to the current x64 redistributable. */
export const VC_REDIST_DOWNLOAD_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
