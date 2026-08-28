// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const openPath = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ shell: { openPath } }));

const { openProducedFile } = await import('./open-file');

/**
 * `openPath` hands a file to the OS to execute with its registered application. The tests
 * that matter are the ones about what it refuses.
 */

const dir = mkdtempSync(join(tmpdir(), 'ocr-open-'));

function file(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  return path;
}

describe('openProducedFile', () => {
  it('opens a document this application produces', () => {
    const result = openProducedFile(file('report.md'));

    expect(result.status).toBe('opened');
    expect(openPath).toHaveBeenCalled();
  });

  it.each(['run.exe', 'run.bat', 'run.ps1', 'run.cmd', 'shortcut.lnk', 'saver.scr'])(
    'refuses to execute %s',
    (name) => {
      openPath.mockClear();

      const result = openProducedFile(file(name));

      expect(result).toEqual({ status: 'refused', reason: 'unsupported-type' });
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  it('refuses a file with no extension', () => {
    openPath.mockClear();

    expect(openProducedFile(file('README')).status).toBe('refused');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('refuses a relative path', () => {
    openPath.mockClear();

    expect(openProducedFile('reports/out.md')).toEqual({
      status: 'refused',
      reason: 'not-a-path',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it.each<{ value: unknown; label: string }>([
    { value: '', label: 'an empty string' },
    { value: 42, label: 'a number' },
    { value: null, label: 'null' },
    { value: {}, label: 'an object' },
  ])('refuses $label rather than trusting the channel', ({ value }) => {
    openPath.mockClear();

    expect(openProducedFile(value).status).toBe('refused');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('reports a file that is gone rather than failing', () => {
    // Quick Mode results expire, so this is normal for a window left open.
    openPath.mockClear();

    expect(openProducedFile(join(dir, 'swept.md'))).toEqual({
      status: 'refused',
      reason: 'missing',
    });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('refuses a directory that happens to be named like a document', () => {
    openPath.mockClear();
    const path = join(dir, 'folder.md');
    mkdirSync(path);

    expect(openProducedFile(path).status).toBe('refused');
    expect(openPath).not.toHaveBeenCalled();
  });
});
