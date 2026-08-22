// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { archiveFileName, buildResultArchive, type ArchiveEntry } from './result-archive';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-zip-'));
});

async function outputFile(name: string, contents = 'x'): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

/** Read the produced archive back, since asserting on bytes proves nothing. */
async function entriesOf(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));

  return await new Promise((resolve, reject) => {
    fromBuffer(Buffer.concat(chunks), { lazyEntries: true }, (error, zip?: ZipFile) => {
      if (error || zip === undefined) return reject(error ?? new Error('no zip'));
      const names: string[] = [];
      zip.on('entry', (entry: Entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('buildResultArchive', () => {
  it('groups each output under the document it came from', async () => {
    const entries: ArchiveEntry[] = [
      { path: await outputFile('invoice.md'), documentName: 'invoice' },
      { path: await outputFile('invoice.json'), documentName: 'invoice' },
      { path: await outputFile('receipt.md'), documentName: 'receipt' },
    ];

    const archive = await buildResultArchive(entries);

    // Flat, three documents times four formats interleave into an unreadable list.
    expect(await entriesOf(archive.stream)).toEqual([
      'invoice/invoice.md',
      'invoice/invoice.json',
      'receipt/receipt.md',
    ]);
    expect(archive.included).toBe(3);
  });

  it('zips a single output too, rather than changing shape', async () => {
    const archive = await buildResultArchive([
      { path: await outputFile('only.txt'), documentName: 'only' },
    ]);

    expect(await entriesOf(archive.stream)).toEqual(['only/only.txt']);
  });

  it('skips outputs that have gone, rather than failing the whole download', async () => {
    const archive = await buildResultArchive([
      { path: await outputFile('kept.md'), documentName: 'kept' },
      { path: join(root, 'swept-away.md'), documentName: 'gone' },
    ]);

    // A partial archive beats an error saying everything is lost.
    expect(await entriesOf(archive.stream)).toEqual(['kept/kept.md']);
    expect(archive.included).toBe(1);
    expect(archive.missing).toHaveLength(1);
  });

  it('produces a valid empty archive when nothing survives', async () => {
    const archive = await buildResultArchive([
      { path: join(root, 'nothing.md'), documentName: 'nothing' },
    ]);

    expect(await entriesOf(archive.stream)).toEqual([]);
  });

  it('disambiguates entries that would otherwise collide', async () => {
    const first = await outputFile('a/page.md');
    const second = await outputFile('b/page.md');

    const archive = await buildResultArchive([
      { path: first, documentName: 'scan' },
      { path: second, documentName: 'scan' },
    ]);

    // Two identical names in one ZIP extract unpredictably.
    expect(await entriesOf(archive.stream)).toEqual(['scan/page.md', 'scan/page (2).md']);
  });

  it('refuses to let a name escape the extraction directory', async () => {
    const archive = await buildResultArchive([
      { path: await outputFile('safe.md'), documentName: '../../etc' },
    ]);

    const [name] = await entriesOf(archive.stream);
    expect(name).not.toContain('..');
    expect(name?.startsWith('/')).toBe(false);
  });
});

describe('archiveFileName', () => {
  it('names the download after the document, so three runs are tellable apart', () => {
    // Every run used to download as impressive-ocr-results.zip, then (1), then (2).
    const name = archiveFileName([
      { path: '/out/invoice-2411.md', documentName: 'invoice-2411.pdf' },
      { path: '/out/invoice-2411.docx', documentName: 'invoice-2411.pdf' },
    ]);

    expect(name).toBe('invoice-2411.zip');
  });

  it('uses the first document name even when a run covered several', () => {
    // Deliberately just the first name: anything appended to it is a string a real document
    // could also be called, and two runs would then produce the same download name.
    const name = archiveFileName([
      { path: '/out/a.md', documentName: 'a.pdf' },
      { path: '/out/b.md', documentName: 'b.pdf' },
      { path: '/out/c.md', documentName: 'c.pdf' },
    ]);

    expect(name).toBe('a.zip');
  });

  it('strips what a filename may not contain', () => {
    const name = archiveFileName([{ path: '/out/x.md', documentName: 'in/voi:ce "2024".pdf' }]);

    expect(name).toBe('in-voice 2024.zip');
  });

  it('falls back when there is nothing to name it after', () => {
    expect(archiveFileName([])).toBe('impressive-ocr-results.zip');
  });
});
