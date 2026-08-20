// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCollisionPolicy,
  applyPostAction,
  listProduced,
  planDestinations,
} from './output-mover';
import { exists } from '../../infra/fs/file-ops';
import { createLogger } from '../../infra/logger';

const logger = createLogger({ level: 'silent', pretty: false });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-outputs-'));
});

describe('planDestinations', () => {
  const request = {
    workDir: join('D:', 'work', 'job1'),
    outputRoot: join('D:', 'out'),
    relativeDirectory: '',
    outputStem: 'invoice 4711',
  };

  it('renames a produced file onto the job output stem', () => {
    const plan = planDestinations(
      [{ format: 'markdown', relativePath: join('markdown', 'whatever.md') }],
      request,
    );

    expect(plan[0]?.to).toBe(join('D:', 'out', 'invoice 4711_whatever.md'));
  });

  it('keeps a per-page suffix so a multi-page scan does not collapse onto one name', () => {
    // PaddleOCR writes one file per page. Without preserving the suffix, 40 pages would
    // fight over a single destination.
    const plan = planDestinations(
      [
        { format: 'markdown', relativePath: join('markdown', 'invoice 4711_page_001.md') },
        { format: 'markdown', relativePath: join('markdown', 'invoice 4711_page_002.md') },
      ],
      request,
    );

    expect(plan.map((entry) => entry.to)).toEqual([
      join('D:', 'out', 'invoice 4711_page_001.md'),
      join('D:', 'out', 'invoice 4711_page_002.md'),
    ]);
  });

  it('produces a clean name when Paddle used the stem exactly', () => {
    const plan = planDestinations(
      [{ format: 'json', relativePath: join('json', 'invoice 4711.json') }],
      request,
    );

    expect(plan[0]?.to).toBe(join('D:', 'out', 'invoice 4711.json'));
  });

  it('mirrors the input folder structure when asked to', () => {
    const plan = planDestinations(
      [{ format: 'markdown', relativePath: join('markdown', 'invoice 4711.md') }],
      { ...request, relativeDirectory: join('2024', 'q1') },
    );

    expect(plan[0]?.to).toBe(join('D:', 'out', '2024', 'q1', 'invoice 4711.md'));
  });
});

describe('applyCollisionPolicy', () => {
  it('returns the destination unchanged when nothing is there', async () => {
    const target = join(root, 'new.md');

    expect(await applyCollisionPolicy(target, 'suffix')).toBe(target);
  });

  it('numbers the file when suffixing', async () => {
    const target = join(root, 'report.md');
    await writeFile(target, 'existing');

    expect(await applyCollisionPolicy(target, 'suffix')).toBe(join(root, 'report (2).md'));
  });

  it('keeps counting past an already-suffixed file', async () => {
    await writeFile(join(root, 'report.md'), 'a');
    await writeFile(join(root, 'report (2).md'), 'b');

    expect(await applyCollisionPolicy(join(root, 'report.md'), 'suffix')).toBe(
      join(root, 'report (3).md'),
    );
  });

  it('returns the same path when overwriting', async () => {
    const target = join(root, 'report.md');
    await writeFile(target, 'existing');

    expect(await applyCollisionPolicy(target, 'overwrite')).toBe(target);
  });

  it('returns null when skipping', async () => {
    const target = join(root, 'report.md');
    await writeFile(target, 'existing');

    expect(await applyCollisionPolicy(target, 'skip')).toBeNull();
  });
});

describe('applyPostAction', () => {
  async function makeSource(name = 'invoice.pdf'): Promise<string> {
    const inputRoot = join(root, 'in');
    const path = join(inputRoot, name);
    await writeFile(join(root, '.keep'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'pdf');
    return path;
  }

  it('leaves the source alone for "keep"', async () => {
    const source = await makeSource();

    await applyPostAction({
      sourcePath: source,
      inputRoot: join(root, 'in'),
      outputRoot: join(root, 'out'),
      archivePath: undefined,
      action: 'keep',
      logger,
    });

    expect(await exists(source)).toBe(true);
  });

  it('deletes the source for "delete"', async () => {
    const source = await makeSource();

    await applyPostAction({
      sourcePath: source,
      inputRoot: join(root, 'in'),
      outputRoot: join(root, 'out'),
      archivePath: undefined,
      action: 'delete',
      logger,
    });

    expect(await exists(source)).toBe(false);
  });

  it('moves the source into the archive, preserving its subfolder', async () => {
    const source = await makeSource(join('2024', 'invoice.pdf'));
    const archive = join(root, 'archive');

    await applyPostAction({
      sourcePath: source,
      inputRoot: join(root, 'in'),
      outputRoot: join(root, 'out'),
      archivePath: archive,
      action: 'move-to-archive',
      logger,
    });

    expect(await exists(source)).toBe(false);
    expect(await exists(join(archive, '2024', 'invoice.pdf'))).toBe(true);
  });

  it('keeps the source when the archive folder is not configured', async () => {
    const source = await makeSource();

    await applyPostAction({
      sourcePath: source,
      inputRoot: join(root, 'in'),
      outputRoot: join(root, 'out'),
      archivePath: undefined,
      action: 'move-to-archive',
      logger,
    });

    expect(await exists(source)).toBe(true);
  });

  it('never throws when the source has already vanished', async () => {
    // The OCR already succeeded and its outputs are on disk. Failing here would retry the
    // whole job and produce every output a second time.
    await expect(
      applyPostAction({
        sourcePath: join(root, 'in', 'gone.pdf'),
        inputRoot: join(root, 'in'),
        outputRoot: join(root, 'out'),
        archivePath: undefined,
        action: 'move-to-output',
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('listProduced', () => {
  it('lists nested files relative to the scratch directory', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'markdown'), { recursive: true });
    await mkdir(join(root, 'json'), { recursive: true });
    await writeFile(join(root, 'markdown', 'a.md'), 'x');
    await writeFile(join(root, 'json', 'a.json'), 'x');

    expect(await listProduced(root)).toEqual([join('json', 'a.json'), join('markdown', 'a.md')]);
  });

  it('returns nothing for a directory that was never created', async () => {
    expect(await listProduced(join(root, 'absent'))).toEqual([]);
  });

  it('returns nothing for an empty scratch directory', async () => {
    await readdir(root);

    expect(await listProduced(root)).toEqual([]);
  });
});
