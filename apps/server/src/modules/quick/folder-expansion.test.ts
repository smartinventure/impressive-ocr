// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expandFolders, MAX_FOLDER_FILES, previewFolder } from './folder-expansion';

/**
 * Turning the chosen folders into the files a Quick run will read, and counting them first.
 *
 * On the server because neither picker can do it: a web page cannot list a directory, and the
 * desktop's own dialog hands back the folder rather than its contents.
 */

let folder: string;
let second: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'impressive-ocr-folder-'));
  second = await mkdtemp(join(tmpdir(), 'impressive-ocr-folder-'));
});

async function put(...names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(join(folder, name), 'x');
  }
}

async function putIn(target: string, ...names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(join(target, name), 'x');
  }
}

describe('expandFolders, over one folder', () => {
  it('takes the file types that were asked for', async () => {
    await put('a.pdf', 'b.png', 'notes.txt');

    const result = await expandFolders([folder], ['pdf', 'png']);

    expect(result.files.map((file) => basename(file))).toEqual(['a.pdf', 'b.png']);
  });

  it('counts what it left out, so the screen can say so', async () => {
    // "Nothing happened" with no reason is the least useful outcome; the count is what turns
    // it into "wrong file types".
    await put('a.pdf', 'notes.txt', 'sheet.xlsx');

    expect((await expandFolders([folder], ['pdf'])).skipped).toBe(2);
  });

  it('ignores the dot and the case of an extension', async () => {
    await put('SCAN.PDF');

    expect((await expandFolders([folder], ['.pdf'])).files).toHaveLength(1);
  });

  it('does not descend into subfolders', async () => {
    // A one-off run over a folder someone is looking at. Walking a tree of thousands is a
    // watched pipeline's job and would queue work nobody asked for.
    await put('top.pdf');
    await mkdir(join(folder, 'nested'));
    await writeFile(join(folder, 'nested', 'deep.pdf'), 'x');

    const result = await expandFolders([folder], ['pdf']);

    expect(result.files).toHaveLength(1);
    // The subfolder is not a rejected *file*, so it must not inflate the skipped count.
    expect(result.skipped).toBe(0);
  });

  it('sorts them the way a file manager would', async () => {
    await put('c.pdf', 'a.pdf', 'b.pdf');

    const names = (await expandFolders([folder], ['pdf'])).files.map((file) => basename(file));

    expect(names).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('caps a folder that would queue more than one click should', async () => {
    const many = Array.from({ length: MAX_FOLDER_FILES + 10 }, (_, i) => `${i + 1000}.pdf`);
    await put(...many);

    const result = await expandFolders([folder], ['pdf']);

    expect(result.files).toHaveLength(MAX_FOLDER_FILES);
    expect(result.truncated).toBe(true);
  });

  it('reports an empty folder as empty rather than failing', async () => {
    const result = await expandFolders([folder], ['pdf']);

    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

/**
 * Several folders at once.
 *
 * One dialog returns one folder, and scans are routinely split across several. The alternative
 * -- a run per folder -- gives up the single progress bar and single output folder that are
 * the point of Quick Mode.
 */
describe('expandFolders', () => {
  it('takes the files from every folder given', async () => {
    await put('a.pdf');
    await putIn(second, 'b.pdf');

    const result = await expandFolders([folder, second], ['pdf']);

    expect(result.files.map((file) => basename(file))).toEqual(['a.pdf', 'b.pdf']);
  });

  it('keeps the folders in the order they were chosen', async () => {
    // Sorting is within a folder, not across: which folder came first is itself a choice.
    await put('z.pdf');
    await putIn(second, 'a.pdf');

    const names = (await expandFolders([folder, second], ['pdf'])).files.map((f) => basename(f));

    expect(names).toEqual(['z.pdf', 'a.pdf']);
  });

  it('caps the total rather than each folder', async () => {
    // The cap bounds one click's work, and that work is the same however it is divided.
    const half = Math.ceil(MAX_FOLDER_FILES / 2) + 5;
    await put(...Array.from({ length: half }, (_, i) => `a${i + 1000}.pdf`));
    await putIn(second, ...Array.from({ length: half }, (_, i) => `b${i + 1000}.pdf`));

    const result = await expandFolders([folder, second], ['pdf']);

    expect(result.files).toHaveLength(MAX_FOLDER_FILES);
    expect(result.truncated).toBe(true);
  });

  it('adds up what it left out across all of them', async () => {
    await put('a.pdf', 'notes.txt');
    await putIn(second, 'b.pdf', 'sheet.xlsx');

    expect((await expandFolders([folder, second], ['pdf'])).skipped).toBe(2);
  });
});

/**
 * What a folder holds, before anything runs.
 *
 * A folder chooser returns a name and nothing else, so "run this folder" was a decision made
 * blind. This is what lets the picker offer only the types that are there and put a number
 * against the run.
 */
describe('previewFolder', () => {
  it('counts each readable type it finds', async () => {
    await put('a.pdf', 'b.pdf', 'c.png');

    const preview = await previewFolder(folder);

    expect(preview.counts).toEqual([
      { extension: 'pdf', files: 2 },
      { extension: 'png', files: 1 },
    ]);
  });

  it('offers nothing for a type the folder does not hold', async () => {
    // A chip for an absent type is a filter that does nothing, on a screen whose whole job is
    // to say what will be read.
    await put('a.pdf');

    expect((await previewFolder(folder)).counts.map((c) => c.extension)).toEqual(['pdf']);
  });

  it('counts what the engine cannot read separately', async () => {
    // So a count smaller than the folder is explainable rather than alarming.
    await put('a.pdf', 'notes.txt', 'sheet.xlsx');

    const preview = await previewFolder(folder);

    expect(preview.other).toBe(2);
    expect(preview.counts).toEqual([{ extension: 'pdf', files: 1 }]);
  });

  it('treats an upper-case extension as the same type', async () => {
    await put('SCAN.PDF', 'scan2.pdf');

    expect((await previewFolder(folder)).counts).toEqual([{ extension: 'pdf', files: 2 }]);
  });

  it('keeps a stable type order, so the chips do not reshuffle', async () => {
    // Collected in encounter order the chips would jump about as folders are added.
    await put('b.png', 'a.pdf', 'c.tiff');

    const order = (await previewFolder(folder)).counts.map((entry) => entry.extension);

    expect(order).toEqual(['pdf', 'png', 'tiff']);
  });

  it('does not count subfolders as files', async () => {
    await put('a.pdf');
    await mkdir(join(folder, 'nested'));

    const preview = await previewFolder(folder);

    expect(preview.other).toBe(0);
    expect(preview.counts).toEqual([{ extension: 'pdf', files: 1 }]);
  });

  it('reports an empty folder as holding nothing', async () => {
    const preview = await previewFolder(folder);

    expect(preview.counts).toEqual([]);
    expect(preview.other).toBe(0);
  });
});
