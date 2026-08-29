// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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

/**
 * Absolute roots that are absolute on *both* platforms.
 *
 * `join(DRIVE, 'out')` is a drive-rooted absolute path on Windows and a plain relative one on
 * Linux, where "D:" is just a directory name. `planDestinations` resolves what it is given,
 * so on the Linux CI leg these assertions compared a drive letter against the runner's
 * checkout directory and failed for a reason that had nothing to do with the code.
 */
const DRIVE = process.platform === 'win32' ? 'D:\\' : '/d';
const OTHER_DRIVE = process.platform === 'win32' ? 'C:\\' : '/c';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-outputs-'));
});

describe('planDestinations', () => {
  const request = {
    workDir: join(DRIVE, 'work', 'job1'),
    outputRoot: join(DRIVE, 'out'),
    relativeDirectory: '',
    outputStem: 'invoice 4711',
  };

  it('renames a produced file onto the job output stem', () => {
    // Paddle's own name is discarded, not appended. It names a PDF's rasterised page after
    // the job's temporary directory, so appending it produced
    // `invoice 4711_impressive-ocr-p1-8c2yltko.md` — an internal identifier in the user's
    // output folder, different on every run. With one file for this format there is nothing
    // to tell apart, so there is nothing to add.
    const plan = planDestinations(
      [{ format: 'markdown', relativePath: join('markdown', 'whatever.md') }],
      request,
    );

    expect(plan[0]?.to).toBe(join(DRIVE, 'out', 'invoice 4711.md'));
  });

  it('numbers several files whose names it cannot use', () => {
    // The multi-page version of the same problem: the names carry no page number, so the
    // position does. 1-based, because `_1`, `_2` reads as pages where `_0` reads as an index.
    const plan = planDestinations(
      [
        { format: 'markdown', relativePath: join('markdown', 'tmp-aaa.md') },
        { format: 'markdown', relativePath: join('markdown', 'tmp-bbb.md') },
      ],
      request,
    );

    expect(plan.map((entry) => entry.to)).toEqual([
      join(DRIVE, 'out', 'invoice 4711_1.md'),
      join(DRIVE, 'out', 'invoice 4711_2.md'),
    ]);
  });

  it('drops the page suffix when a format produced only one file', () => {
    // A one-page scan came out as `invoice 4711_0.md` while its searchable PDF, written by a
    // writer that names its own file, came out clean. Same document, two conventions.
    const plan = planDestinations(
      [{ format: 'markdown', relativePath: join('markdown', 'invoice 4711_0.md') }],
      request,
    );

    expect(plan[0]?.to).toBe(join(DRIVE, 'out', 'invoice 4711.md'));
  });

  it('keeps each format independent when counting', () => {
    // Two Markdown pages and one Word file: the Word file is alone and takes no suffix.
    const plan = planDestinations(
      [
        { format: 'markdown', relativePath: join('markdown', 'invoice 4711_0.md') },
        { format: 'markdown', relativePath: join('markdown', 'invoice 4711_1.md') },
        { format: 'docx', relativePath: join('docx', 'invoice 4711_0.docx') },
      ],
      request,
    );

    expect(plan.map((entry) => entry.to)).toEqual([
      join(DRIVE, 'out', 'invoice 4711_0.md'),
      join(DRIVE, 'out', 'invoice 4711_1.md'),
      join(DRIVE, 'out', 'invoice 4711.docx'),
    ]);
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
      join(DRIVE, 'out', 'invoice 4711_page_001.md'),
      join(DRIVE, 'out', 'invoice 4711_page_002.md'),
    ]);
  });

  it('produces a clean name when Paddle used the stem exactly', () => {
    const plan = planDestinations(
      [{ format: 'json', relativePath: join('json', 'invoice 4711.json') }],
      request,
    );

    expect(plan[0]?.to).toBe(join(DRIVE, 'out', 'invoice 4711.json'));
  });

  it('mirrors the input folder structure when asked to', () => {
    const plan = planDestinations(
      [{ format: 'markdown', relativePath: join('markdown', 'invoice 4711.md') }],
      { ...request, relativeDirectory: join('2024', 'q1') },
    );

    expect(plan[0]?.to).toBe(join(DRIVE, 'out', '2024', 'q1', 'invoice 4711.md'));
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

describe('planDestinations containment', () => {
  it('keeps results inside the chosen output folder when the source sits outside the input', () => {
    // A Quick run's files come from anywhere, so `relative(inputPath, sourcePath)` yields
    // `..` segments. Followed literally, they wrote the results next to the originals.
    const plan = planDestinations([{ format: 'markdown', relativePath: 'doc.md' }], {
      workDir: join(OTHER_DRIVE, 'work'),
      outputRoot: join(OTHER_DRIVE, 'scans', 'out'),
      relativeDirectory: join('..', 'in'),
      outputStem: 'doc',
    });

    expect(plan[0]?.to.startsWith(join(OTHER_DRIVE, 'scans', 'out'))).toBe(true);
  });

  it('still honours a genuine subfolder', () => {
    const plan = planDestinations([{ format: 'markdown', relativePath: 'doc.md' }], {
      workDir: join(OTHER_DRIVE, 'work'),
      outputRoot: join(OTHER_DRIVE, 'scans', 'out'),
      relativeDirectory: join('2026', 'january'),
      outputStem: 'doc',
    });

    expect(plan[0]?.to).toBe(join(OTHER_DRIVE, 'scans', 'out', '2026', 'january', 'doc.md'));
  });

  it('treats an absolute relativeDirectory as an escape attempt', () => {
    const plan = planDestinations([{ format: 'txt', relativePath: 'doc.txt' }], {
      workDir: join(OTHER_DRIVE, 'work'),
      outputRoot: join(OTHER_DRIVE, 'scans', 'out'),
      relativeDirectory: join(DRIVE, 'elsewhere'),
      outputStem: 'doc',
    });

    expect(plan[0]?.to.startsWith(join(OTHER_DRIVE, 'scans', 'out'))).toBe(true);
  });
});

/**
 * Where the original goes when the pipeline is told to move it to the output folder.
 *
 * It used to land beside the results and be told apart from them by a number: a pipeline
 * producing a searchable `report.pdf` moved the scan in as `report (2).pdf`. In a folder of
 * outputs, the one file that is the user's own document was the one they had to guess about.
 */
describe('applyPostAction into the output folder', () => {
  it('puts the original in its own subfolder, clear of the results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocr-post-'));
    const input = join(root, 'in');
    const output = join(root, 'out');
    await mkdir(input, { recursive: true });
    await mkdir(output, { recursive: true });

    const source = join(input, 'report.pdf');
    await writeFile(source, 'scan');
    // The output the pipeline already wrote, with the very same name.
    await writeFile(join(output, 'report.pdf'), 'searchable');

    await applyPostAction({
      sourcePath: source,
      inputRoot: input,
      outputRoot: output,
      archivePath: undefined,
      action: 'move-to-output',
      logger,
    });

    expect(await exists(join(output, 'originals', 'report.pdf'))).toBe(true);
    // The result is untouched and keeps its name.
    expect(await readFile(join(output, 'report.pdf'), 'utf8')).toBe('searchable');
    expect(await exists(join(output, 'report (2).pdf'))).toBe(false);
    expect(await exists(source)).toBe(false);
  });

  it('mirrors the input subfolder inside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocr-post-'));
    const input = join(root, 'in');
    const output = join(root, 'out');
    await mkdir(join(input, 'january'), { recursive: true });
    await mkdir(output, { recursive: true });

    const source = join(input, 'january', 'report.pdf');
    await writeFile(source, 'scan');

    await applyPostAction({
      sourcePath: source,
      inputRoot: input,
      outputRoot: output,
      archivePath: undefined,
      action: 'move-to-output',
      logger,
    });

    expect(await exists(join(output, 'originals', 'january', 'report.pdf'))).toBe(true);
  });

  it('does not add a subfolder for an archive, which is already separate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocr-post-'));
    const input = join(root, 'in');
    const archive = join(root, 'archive');
    await mkdir(input, { recursive: true });

    const source = join(input, 'report.pdf');
    await writeFile(source, 'scan');

    await applyPostAction({
      sourcePath: source,
      inputRoot: input,
      outputRoot: join(root, 'out'),
      archivePath: archive,
      action: 'move-to-archive',
      logger,
    });

    expect(await exists(join(archive, 'report.pdf'))).toBe(true);
  });

  it('keeps a source from outside the input root inside the destination', async () => {
    // `relative()` yields `..` segments for one of those, and the move would land outside the
    // folder the user nominated.
    const root = await mkdtemp(join(tmpdir(), 'ocr-post-'));
    const input = join(root, 'in');
    const output = join(root, 'out');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(input, { recursive: true });
    await mkdir(output, { recursive: true });
    await mkdir(elsewhere, { recursive: true });

    const source = join(elsewhere, 'stray.pdf');
    await writeFile(source, 'scan');

    await applyPostAction({
      sourcePath: source,
      inputRoot: input,
      outputRoot: output,
      archivePath: undefined,
      action: 'move-to-output',
      logger,
    });

    expect(await exists(join(output, 'originals', 'stray.pdf'))).toBe(true);
    expect(await exists(join(root, 'stray.pdf'))).toBe(false);
  });
});
