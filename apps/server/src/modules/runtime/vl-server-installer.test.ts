// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flatten } from './vl-server-installer';

/**
 * Where the extracted binaries end up.
 *
 * llama.cpp does not lay its archives out consistently — some put the executables at the
 * root, others under `build/bin/` — and the Windows CUDA build arrives as two archives that
 * must merge. Getting this wrong has no loud failure mode: `llama-server` is simply not where
 * the pool looks, every accurate job quietly falls back to the slow backend, and the only
 * symptom is that OCR is thirty times slower than it should be.
 */

async function tree(layout: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-flatten-'));
  for (const [path, contents] of Object.entries(layout)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

describe('flatten', () => {
  it('leaves an already-flat archive alone', async () => {
    const root = await tree({ 'llama-server.exe': 'server', 'ggml.dll': 'lib' });

    await flatten(root);

    expect((await readdir(root)).sort()).toEqual(['ggml.dll', 'llama-server.exe']);
  });

  it('lifts executables out of a nested build directory', async () => {
    const root = await tree({
      'build/bin/llama-server': 'server',
      'build/bin/llama-quantize': 'quantiser',
    });

    await flatten(root);

    const entries = await readdir(root);
    expect(entries.sort()).toEqual(['llama-quantize', 'llama-server']);
  });

  it('merges two archives that unpacked into different shapes', async () => {
    // Exactly the Windows CUDA case: the server in one archive, the CUDA runtime in another.
    const root = await tree({
      'llama-server.exe': 'server',
      'cudart/cudart64_12.dll': 'runtime',
      'cudart/cublas64_12.dll': 'runtime',
    });

    await flatten(root);

    const entries = await readdir(root);
    expect(entries).toContain('llama-server.exe');
    expect(entries).toContain('cudart64_12.dll');
    expect(entries).toContain('cublas64_12.dll');
  });

  it('removes the directories it emptied', async () => {
    // Left behind, they would be walked again on the next install and make `bin/` look like
    // it contains subdirectories that no longer hold anything.
    const root = await tree({ 'a/b/c/llama-server': 'server' });

    await flatten(root);

    expect(await readdir(root)).toEqual(['llama-server']);
  });
});
