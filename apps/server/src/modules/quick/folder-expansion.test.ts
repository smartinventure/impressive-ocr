// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expandFolder, MAX_FOLDER_FILES } from './folder-expansion';

/**
 * Turning a chosen folder into the files a Quick run will read.
 *
 * On the server because neither picker can do it: a web page cannot list a directory, and the
 * desktop's own dialog hands back the folder rather than its contents.
 */

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'impressive-ocr-folder-'));
});

async function put(...names: string[]): Promise<void> {
  for (const name of names) {
    await writeFile(join(folder, name), 'x');
  }
}

describe('expandFolder', () => {
  it('takes the file types that were asked for', async () => {
    await put('a.pdf', 'b.png', 'notes.txt');

    const result = await expandFolder(folder, ['pdf', 'png']);

    expect(result.files.map((file) => basename(file))).toEqual(['a.pdf', 'b.png']);
  });

  it('counts what it left out, so the screen can say so', async () => {
    // "Nothing happened" with no reason is the least useful outcome; the count is what turns
    // it into "wrong file types".
    await put('a.pdf', 'notes.txt', 'sheet.xlsx');

    expect((await expandFolder(folder, ['pdf'])).skipped).toBe(2);
  });

  it('ignores the dot and the case of an extension', async () => {
    await put('SCAN.PDF');

    expect((await expandFolder(folder, ['.pdf'])).files).toHaveLength(1);
  });

  it('does not descend into subfolders', async () => {
    // A one-off run over a folder someone is looking at. Walking a tree of thousands is a
    // watched pipeline's job and would queue work nobody asked for.
    await put('top.pdf');
    await mkdir(join(folder, 'nested'));
    await writeFile(join(folder, 'nested', 'deep.pdf'), 'x');

    const result = await expandFolder(folder, ['pdf']);

    expect(result.files).toHaveLength(1);
    // The subfolder is not a rejected *file*, so it must not inflate the skipped count.
    expect(result.skipped).toBe(0);
  });

  it('sorts them the way a file manager would', async () => {
    await put('c.pdf', 'a.pdf', 'b.pdf');

    const names = (await expandFolder(folder, ['pdf'])).files.map((file) => basename(file));

    expect(names).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('caps a folder that would queue more than one click should', async () => {
    const many = Array.from({ length: MAX_FOLDER_FILES + 10 }, (_, i) => `${i + 1000}.pdf`);
    await put(...many);

    const result = await expandFolder(folder, ['pdf']);

    expect(result.files).toHaveLength(MAX_FOLDER_FILES);
    expect(result.truncated).toBe(true);
  });

  it('reports an empty folder as empty rather than failing', async () => {
    const result = await expandFolder(folder, ['pdf']);

    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
