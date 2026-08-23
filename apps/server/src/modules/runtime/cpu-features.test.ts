// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_FEATURES,
  parseDarwinSysctl,
  parseLinuxCpuFlags,
  parseWindowsProbeOutput,
} from './cpu-features';

/**
 * A CPU without AVX cannot run any current PaddlePaddle build.
 *
 * These parsers decide whether a multi-gigabyte download is worth starting, so the cost of a
 * wrong answer is asymmetric: a false "no" refuses a machine that would have worked, while a
 * false "yes" ends in an illegal-instruction fault the user cannot interpret. Anything that
 * cannot be read confidently must come back `unknown`, which never blocks.
 */
describe('parseWindowsProbeOutput', () => {
  it('reads the AVX and AVX2 flags the PowerShell probe writes', () => {
    expect(parseWindowsProbeOutput('AVX=1\r\nAVX2=1\r\n')).toEqual({ avx: 'yes', avx2: 'yes' });
  });

  it('reports no AVX on a CPU that lacks it', () => {
    // Measured on an Intel Pentium 4415Y (Kaby Lake). Intel disables AVX on the Pentium and
    // Celeron SKUs of a generation whose Core parts have it, so "recent x86-64" says nothing
    // about AVX. This exact output came from that machine.
    expect(parseWindowsProbeOutput('AVX=0\r\nAVX2=0\r\n')).toEqual({ avx: 'no', avx2: 'no' });
  });

  it('handles a CPU with AVX but not AVX2', () => {
    expect(parseWindowsProbeOutput('AVX=1\nAVX2=0\n')).toEqual({ avx: 'yes', avx2: 'no' });
  });

  it('returns unknown for output it cannot read, rather than guessing "no"', () => {
    expect(parseWindowsProbeOutput('')).toEqual(UNKNOWN_FEATURES);
    expect(parseWindowsProbeOutput('Add-Type : some error')).toEqual(UNKNOWN_FEATURES);
  });
});

describe('parseLinuxCpuFlags', () => {
  const cpuinfo = (flags: string): string =>
    ['processor\t: 0', 'model name\t: Whatever', `flags\t\t: ${flags}`, ''].join('\n');

  it('finds avx and avx2 among the flags', () => {
    const features = parseLinuxCpuFlags(cpuinfo('fpu vme de pse avx avx2 sse4_2'));

    expect(features).toEqual({ avx: 'yes', avx2: 'yes' });
  });

  it('does not report avx just because avx512f is present as a substring', () => {
    // A naive substring test matches 'avx' inside 'avx512f'. That is the wrong direction of
    // error here, but the same sloppiness would match nothing on the CPUs this exists to catch.
    const features = parseLinuxCpuFlags(cpuinfo('fpu sse4_2 avx512f'));

    expect(features.avx).toBe('no');
    expect(features.avx2).toBe('no');
  });

  it('reports no AVX when the flags line lists none', () => {
    expect(parseLinuxCpuFlags(cpuinfo('fpu vme de pse tsc msr'))).toEqual({
      avx: 'no',
      avx2: 'no',
    });
  });

  it('returns unknown when there is no flags line at all', () => {
    expect(parseLinuxCpuFlags('processor\t: 0\n')).toEqual(UNKNOWN_FEATURES);
  });
});

describe('parseDarwinSysctl', () => {
  it('reads the two values sysctl prints, in the order requested', () => {
    expect(parseDarwinSysctl('1\n1\n')).toEqual({ avx: 'yes', avx2: 'yes' });
  });

  it('treats a missing second value as absent rather than unknown', () => {
    // sysctl omits a key it does not have, so one line back means avx2 is genuinely absent.
    expect(parseDarwinSysctl('1\n')).toEqual({ avx: 'yes', avx2: 'no' });
  });

  it('returns unknown for empty output', () => {
    expect(parseDarwinSysctl('')).toEqual(UNKNOWN_FEATURES);
  });
});
