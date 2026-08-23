// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUIRED_VC_DLLS, probeVcRuntime } from './vc-runtime';

/**
 * A fresh Windows install that has never run an MSVC-built application has no Visual C++
 * redistributable, and PaddlePaddle's DLLs link against it. The resulting failure —
 * `DLL load failed while importing libpaddle` — names neither the file nor the cause, so
 * detecting it up front is the difference between a one-line fix and an afternoon.
 */
describe('probeVcRuntime', () => {
  let root: string;
  let system32: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'impressive-ocr-vc-'));
    system32 = join(root, 'System32');
    await mkdir(system32, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function place(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await writeFile(join(system32, name), '');
    }
  }

  it('reports present when every required DLL is there', async () => {
    await place(REQUIRED_VC_DLLS);

    const report = await probeVcRuntime('win32', root);

    expect(report.status).toBe('present');
    expect(report.missing).toEqual([]);
  });

  it('reports the one DLL that actually breaks PaddleOCR', async () => {
    // Observed chain on a real machine: libpaddle.pyd -> mkldnn.dll -> VCOMP140.DLL, where
    // only vcomp140.dll was absent and everything else resolved.
    await place(REQUIRED_VC_DLLS.filter((dll) => dll !== 'vcomp140.dll'));

    const report = await probeVcRuntime('win32', root);

    expect(report.status).toBe('missing');
    expect(report.missing).toEqual(['vcomp140.dll']);
  });

  it('lists every missing DLL, not just the first', async () => {
    await place(['msvcp140.dll']);

    const report = await probeVcRuntime('win32', root);

    expect(report.missing).toContain('vcomp140.dll');
    expect(report.missing).toContain('vcruntime140_1.dll');
  });

  it('is not applicable away from Windows, where there is no MSVC runtime', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const report = await probeVcRuntime(platform, root);

      expect(report.status).toBe('not-applicable');
      expect(report.missing).toEqual([]);
    }
  });

  it('reports missing rather than throwing when System32 does not exist', async () => {
    const report = await probeVcRuntime('win32', join(root, 'nonexistent'));

    expect(report.status).toBe('missing');
    expect(report.missing).toHaveLength(REQUIRED_VC_DLLS.length);
  });
});
