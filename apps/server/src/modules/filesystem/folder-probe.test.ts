// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { probeFolder } from './folder-probe';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'impressive-ocr-probe-'));
});

async function folderWith(files: number): Promise<string> {
  const target = join(root, `with-${files}`);
  await mkdir(target, { recursive: true });
  for (let index = 0; index < files; index += 1) {
    await writeFile(join(target, `scan-${index}.pdf`), 'x');
  }
  return target;
}

describe('probeFolder, input', () => {
  it('accepts an empty folder with nothing to say', async () => {
    const probe = await probeFolder(await folderWith(0), 'input');

    expect(probe).toEqual({ error: null, warnings: [], entryCount: 0 });
  });

  it('warns that an existing folder will be queued wholesale', async () => {
    const probe = await probeFolder(await folderWith(3), 'input');

    // Not an error: it is a legitimate choice. But the watcher picks all of them up the
    // moment the pipeline starts, which is an expensive thing to discover afterwards.
    expect(probe.error).toBeNull();
    expect(probe.entryCount).toBe(3);
    expect(probe.warnings[0]).toContain('3 files');
    expect(probe.warnings[0]).toContain('queued');
  });

  it('says "file" rather than "files" for exactly one', async () => {
    const probe = await probeFolder(await folderWith(1), 'input');

    expect(probe.warnings[0]).toContain('1 file.');
  });

  it('ignores subfolders when counting', async () => {
    const target = await folderWith(0);
    await mkdir(join(target, 'nested'), { recursive: true });

    expect((await probeFolder(target, 'input')).entryCount).toBe(0);
  });

  it('reports a folder it cannot read, rather than calling it empty', async () => {
    // Injected, because creating a genuinely unreadable directory on Windows means fighting
    // ACLs, and a test that silently no-ops there would be worse than no test.
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    const probe = await probeFolder(root, 'input', {
      openDirectory: () => Promise.reject(denied),
    });

    expect(probe.error).toContain('cannot be read');
    expect(probe.entryCount).toBeNull();
  });

  it('reports a missing folder distinctly from an unreadable one', async () => {
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });

    const probe = await probeFolder(root, 'input', {
      openDirectory: () => Promise.reject(missing),
    });

    expect(probe.error).toContain('no longer exists');
  });

  it('gives up on a folder that does not respond', async () => {
    const probe = await probeFolder(root, 'input', {
      openDirectory: () => new Promise(() => {}),
      timeoutMs: 20,
    });

    expect(probe.error).toContain('did not respond');
  });
});

describe('probeFolder, output', () => {
  it('accepts a writable folder and leaves nothing behind', async () => {
    const target = await folderWith(0);

    const probe = await probeFolder(target, 'output');

    expect(probe.error).toBeNull();
    // The probe file must not survive; an output folder that accumulates dotfiles on every
    // keystroke in the picker would be its own bug.
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects a folder that does not exist', async () => {
    const probe = await probeFolder(join(root, 'not-created-yet'), 'output');

    expect(probe.error).not.toBeNull();
  });

  it('rejects a path that is a file', async () => {
    const file = join(root, 'a-file.txt');
    await writeFile(file, 'x');

    expect((await probeFolder(file, 'output')).error).not.toBeNull();
  });

  it('does not count entries for an output folder', async () => {
    // Output folders are expected to fill up; counting them would only produce noise.
    const probe = await probeFolder(await folderWith(5), 'output');

    expect(probe.warnings).toEqual([]);
    expect(probe.entryCount).toBeNull();
  });
});
