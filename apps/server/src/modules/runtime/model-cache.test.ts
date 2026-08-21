// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../infra/logger';
import { INTERNALS, repairModelCache } from './model-cache';

/**
 * Written after a real failure: an interrupted download left `inference.pdiparams.incomplete`
 * behind, PaddleOCR reported "Model files already exist. Using cached files", and then every
 * run died with "No valid PaddlePaddle model found" — an error naming neither the model nor
 * the download.
 */

const logger = createLogger({ level: 'silent', pretty: false });

let cacheHome: string;
let modelsDir: string;

beforeEach(async () => {
  cacheHome = await mkdtemp(join(tmpdir(), 'impressive-ocr-models-'));
  modelsDir = join(cacheHome, INTERNALS.MODELS_SUBDIRECTORY);
  await mkdir(modelsDir, { recursive: true });
});

async function writeModel(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(modelsDir, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content);
  }
  return dir;
}

describe('repairModelCache', () => {
  it('removes a model whose weights are still marked incomplete', async () => {
    await writeModel('PP-OCRv6_medium_det', {
      'inference.json': '{}',
      [`inference.pdiparams${INTERNALS.INCOMPLETE_SUFFIX}`]: 'partial',
    });

    const result = await repairModelCache(cacheHome, logger);

    expect(result.removed).toEqual(['PP-OCRv6_medium_det']);
    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('keeps a model that downloaded fully', async () => {
    await writeModel('UVDoc', { 'inference.json': '{}', 'inference.pdiparams': 'weights' });

    const result = await repairModelCache(cacheHome, logger);

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(await readdir(modelsDir)).toEqual(['UVDoc']);
  });

  it('removes only the broken models from a mixed cache', async () => {
    // The real case: some models finished before the interruption, some did not. Re-fetching
    // everything would waste hundreds of megabytes.
    await writeModel('Good', { 'inference.pdiparams': 'weights' });
    await writeModel('Broken', { [`inference.pdiparams${INTERNALS.INCOMPLETE_SUFFIX}`]: 'x' });
    await writeModel('AlsoGood', { 'inference.pdiparams': 'weights' });

    const result = await repairModelCache(cacheHome, logger);

    expect(result.removed).toEqual(['Broken']);
    expect((await readdir(modelsDir)).sort()).toEqual(['AlsoGood', 'Good']);
  });

  it('removes the whole directory, not just the partial file', async () => {
    // PaddleOCR's "is it cached?" check is on the directory, so leaving an emptied folder
    // behind would keep the cache poisoned.
    await writeModel('Broken', {
      'inference.json': '{}',
      'config.json': '{}',
      [`inference.pdiparams${INTERNALS.INCOMPLETE_SUFFIX}`]: 'x',
    });

    await repairModelCache(cacheHome, logger);

    expect(await readdir(modelsDir)).toEqual([]);
  });

  it('does nothing when no cache exists yet', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'impressive-ocr-nocache-'));

    await expect(repairModelCache(empty, logger)).resolves.toEqual({ removed: [], kept: 0 });
  });

  it('ignores loose files beside the model directories', async () => {
    await writeFile(join(modelsDir, 'notes.txt'), 'x');
    await writeModel('Good', { 'inference.pdiparams': 'weights' });

    const result = await repairModelCache(cacheHome, logger);

    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
  });
});
