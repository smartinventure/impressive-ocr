// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Does this CPU implement the vector instructions PaddlePaddle was compiled for?
 *
 * PaddlePaddle's published wheels are AVX builds. On a CPU without AVX the library does not
 * run slowly — it dies during `DllMain` with `STATUS_ILLEGAL_INSTRUCTION` (0xC000001D) as
 * `common.dll` executes an instruction the silicon does not implement. Python reports only
 * `DLL load failed`, and PaddlePaddle's own AVX diagnostic is unreachable: it references
 * `libpaddle` inside the `except` block that runs when importing `libpaddle` failed, so it
 * raises `NameError` before it can print the one sentence that would explain everything.
 *
 * Which is to say: nothing downstream will ever tell the user the real reason. This has to.
 *
 * Measured on an Intel Pentium 4415Y, where Intel disables AVX on the Pentium and Celeron
 * SKUs of an otherwise AVX-capable generation — so "modern x86-64" is emphatically not the
 * same question as "has AVX".
 */

/**
 * Tri-state, because a probe that cannot answer must not be mistaken for a negative.
 *
 * `unknown` never blocks an install. Refusing to install because a shell did not respond
 * would be a worse failure than letting the attempt proceed and fail honestly.
 */
export type FeatureSupport = 'yes' | 'no' | 'unknown';

export interface CpuFeatures {
  avx: FeatureSupport;
  avx2: FeatureSupport;
}

export const UNKNOWN_FEATURES: CpuFeatures = { avx: 'unknown', avx2: 'unknown' };

/** A probe must never delay startup; an unanswered one degrades to `unknown`. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Windows exposes CPU features through `IsProcessorFeaturePresent`, not through any file or
 * WMI class, so reaching it means a P/Invoke from PowerShell.
 *
 * Deliberately ASCII-only and free of PowerShell 7 syntax: this has to run under the Windows
 * PowerShell 5.1 that ships with Windows.
 */
const PF_AVX_INSTRUCTIONS_AVAILABLE = 39;
const PF_AVX2_INSTRUCTIONS_AVAILABLE = 40;

const WINDOWS_PROBE_SCRIPT = [
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;",
  'public static class ImpressiveOcrCpu{[DllImport("kernel32.dll")]',
  '[return: MarshalAs(UnmanagedType.Bool)]',
  "public static extern bool IsProcessorFeaturePresent(uint feature);}';",
  `Write-Output ('AVX=' + [int][ImpressiveOcrCpu]::IsProcessorFeaturePresent(${PF_AVX_INSTRUCTIONS_AVAILABLE}));`,
  `Write-Output ('AVX2=' + [int][ImpressiveOcrCpu]::IsProcessorFeaturePresent(${PF_AVX2_INSTRUCTIONS_AVAILABLE}))`,
].join('');

/**
 * PowerShell's `-EncodedCommand` takes base64 of UTF-16LE.
 *
 * Used instead of `-Command` because the script embeds a C# type definition containing double
 * quotes, and passing those through Node's argument escaping and PowerShell's own parser is
 * exactly the kind of quoting that works on one machine and mangles on the next.
 */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export async function detectCpuFeatures(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<CpuFeatures> {
  // AVX is an x86 question. On ARM the relevant question is whether a wheel exists at all,
  // which is `platform-support.ts`'s job, not this one's.
  if (arch !== 'x64' && arch !== 'ia32') {
    return UNKNOWN_FEATURES;
  }

  try {
    if (platform === 'linux') {
      return parseLinuxCpuFlags(await readFile('/proc/cpuinfo', 'utf8'));
    }
    if (platform === 'darwin') {
      const { stdout } = await run('sysctl', ['-n', 'hw.optional.avx1_0', 'hw.optional.avx2_0'], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return parseDarwinSysctl(stdout);
    }
    if (platform === 'win32') {
      // An inline command is not governed by the execution policy, so no bypass is needed —
      // and asking for one on a locked-down machine looks worse than it is.
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(WINDOWS_PROBE_SCRIPT)],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      );
      return parseWindowsProbeOutput(stdout);
    }
  } catch {
    // A probe that fails tells us nothing about the CPU, so say exactly that.
    return UNKNOWN_FEATURES;
  }

  return UNKNOWN_FEATURES;
}

/**
 * Read the `flags` line of /proc/cpuinfo.
 *
 * Matched as whitespace-delimited tokens: a substring test for 'avx' also matches 'avx512f'
 * on a CPU that has neither, and — more importantly — would match nothing at all on the CPUs
 * this check exists to catch.
 */
export function parseLinuxCpuFlags(cpuinfo: string): CpuFeatures {
  for (const line of cpuinfo.split('\n')) {
    if (!line.startsWith('flags') && !line.startsWith('Features')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const flags = new Set(
      line
        .slice(separator + 1)
        .trim()
        .split(/\s+/),
    );
    return {
      avx: flags.has('avx') ? 'yes' : 'no',
      avx2: flags.has('avx2') ? 'yes' : 'no',
    };
  }
  return UNKNOWN_FEATURES;
}

/** `sysctl -n` prints one value per line, in the order the keys were requested. */
export function parseDarwinSysctl(stdout: string): CpuFeatures {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return UNKNOWN_FEATURES;
  }
  return {
    avx: toSupport(lines[0]),
    // A machine can report avx1 and omit avx2 entirely; absent means absent, not unknown.
    avx2: lines.length > 1 ? toSupport(lines[1]) : 'no',
  };
}

/** Parse the `AVX=1` / `AVX2=0` lines the PowerShell probe writes. */
export function parseWindowsProbeOutput(stdout: string): CpuFeatures {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [key, value] = line.trim().split('=');
    if (key !== undefined && value !== undefined) {
      values.set(key.toUpperCase(), value.trim());
    }
  }

  const avx = values.get('AVX');
  const avx2 = values.get('AVX2');
  if (avx === undefined && avx2 === undefined) {
    return UNKNOWN_FEATURES;
  }
  return { avx: toSupport(avx), avx2: toSupport(avx2) };
}

function toSupport(value: string | undefined): FeatureSupport {
  if (value === '1') return 'yes';
  if (value === '0') return 'no';
  return 'unknown';
}
