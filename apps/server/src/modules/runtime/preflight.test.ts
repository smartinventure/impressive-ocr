// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { PreflightCheck, PreflightReport } from '@impressive-ocr/shared';
import { blockingReasons, buildPreflightReport, type PreflightInputs } from './preflight';

/**
 * The distinction under test is "one download away" versus "this will never work".
 *
 * Collapsing the two is the failure this module exists to prevent: on a CPU without AVX, a
 * checker that only understood missing components would install the Visual C++ runtime,
 * report success, and then fail several gigabytes later with `DLL load failed`.
 */

const HEALTHY: PreflightInputs = {
  platform: { support: 'native', reason: '' },
  cpuModel: '12th Gen Intel(R) Core(TM) i7-1265U',
  arch: 'x64',
  features: { avx: 'yes', avx2: 'yes' },
  vcRuntime: { status: 'present', missing: [] },
  disk: { freeBytes: 80 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
  requiredBytes: 2_600_000_000,
  now: new Date('2026-08-21T12:00:00.000Z'),
};

function find(report: PreflightReport, id: PreflightCheck['id']): PreflightCheck {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (check === undefined) {
    throw new Error(`no ${id} check in the report`);
  }
  return check;
}

describe('buildPreflightReport', () => {
  it('clears a healthy machine to install', () => {
    const report = buildPreflightReport(HEALTHY);

    expect(report.canInstall).toBe(true);
    expect(report.hasFixable).toBe(false);
    expect(report.checks.every((check) => check.severity === 'ok')).toBe(true);
  });

  it('blocks a CPU without AVX, because no install can fix it', () => {
    // The machine that prompted this: an Intel Pentium 4415Y, native x86-64, plenty of disk,
    // and completely unable to load the engine.
    const report = buildPreflightReport({
      ...HEALTHY,
      cpuModel: 'Intel(R) Pentium(R) CPU 4415Y @ 1.60GHz',
      features: { avx: 'no', avx2: 'no' },
    });

    expect(report.canInstall).toBe(false);
    expect(find(report, 'cpu-avx').severity).toBe('blocked');
    expect(find(report, 'cpu-avx').remedy).toBeNull();
  });

  it('names the CPU in the AVX message, so the user can act on it', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      cpuModel: 'Intel(R) Pentium(R) CPU 4415Y @ 1.60GHz',
      features: { avx: 'no', avx2: 'no' },
    });

    expect(find(report, 'cpu-avx').detail).toContain('Pentium');
    expect(find(report, 'cpu-avx').detail).toContain('AVX');
  });

  it('offers a remedy for a missing Visual C++ runtime instead of blocking', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      vcRuntime: { status: 'missing', missing: ['vcomp140.dll'] },
    });

    const check = find(report, 'vc-runtime');
    expect(check.severity).toBe('fixable');
    expect(check.remedy?.downloadUrl).toContain('vc_redist.x64.exe');
    // Fixable must not stop an install; the user may already be fixing it in another window.
    expect(report.canInstall).toBe(true);
    expect(report.hasFixable).toBe(true);
  });

  it('names the missing DLLs, since the underlying error names none of them', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      vcRuntime: { status: 'missing', missing: ['vcomp140.dll', 'vcruntime140_1.dll'] },
    });

    expect(find(report, 'vc-runtime').detail).toContain('vcomp140.dll');
  });

  it('reports both a fixable and a blocking problem at once', () => {
    // Exactly the Surface Go: no Visual C++ runtime *and* no AVX. Fixing only the first and
    // declaring victory is the trap.
    const report = buildPreflightReport({
      ...HEALTHY,
      cpuModel: 'Intel(R) Pentium(R) CPU 4415Y @ 1.60GHz',
      features: { avx: 'no', avx2: 'no' },
      vcRuntime: { status: 'missing', missing: ['vcomp140.dll'] },
    });

    expect(report.canInstall).toBe(false);
    expect(report.hasFixable).toBe(true);
    expect(blockingReasons(report)).toHaveLength(1);
  });

  it('blocks an emulated platform', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      platform: { support: 'emulated', reason: 'This is an ARM machine running under emulation.' },
      cpuModel: 'Snapdragon(R) X 12-core X1E80100',
    });

    expect(report.canInstall).toBe(false);
    expect(find(report, 'platform').severity).toBe('blocked');
  });

  it('does not ask about AVX on Apple Silicon, where the question is meaningless', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      arch: 'arm64',
      cpuModel: 'Apple M3 Pro',
      features: { avx: 'unknown', avx2: 'unknown' },
    });

    expect(report.checks.some((check) => check.id === 'cpu-avx')).toBe(false);
    expect(report.canInstall).toBe(true);
  });

  it('omits the Visual C++ check away from Windows', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      vcRuntime: { status: 'not-applicable', missing: [] },
    });

    expect(report.checks.some((check) => check.id === 'vc-runtime')).toBe(false);
  });

  it('does not block when the AVX probe could not answer', () => {
    // A shell that failed to respond says nothing about the CPU. Refusing to install on that
    // basis would be a worse failure than letting the attempt proceed and fail honestly.
    const report = buildPreflightReport({
      ...HEALTHY,
      features: { avx: 'unknown', avx2: 'unknown' },
    });

    expect(report.canInstall).toBe(true);
    expect(find(report, 'cpu-avx').severity).toBe('ok');
  });

  it('treats too little disk space as fixable, not fatal', () => {
    const report = buildPreflightReport({
      ...HEALTHY,
      disk: { freeBytes: 1024 ** 3, totalBytes: 120 * 1024 ** 3 },
    });

    const check = find(report, 'disk-space');
    expect(check.severity).toBe('fixable');
    expect(check.remedy?.downloadUrl).toBeNull();
    expect(report.canInstall).toBe(true);
  });

  it('does not block when free space cannot be measured', () => {
    const report = buildPreflightReport({ ...HEALTHY, disk: null });

    expect(find(report, 'disk-space').severity).toBe('ok');
    expect(report.canInstall).toBe(true);
  });

  it('stamps the time the checks ran', () => {
    expect(buildPreflightReport(HEALTHY).checkedAt).toBe('2026-08-21T12:00:00.000Z');
  });
});
