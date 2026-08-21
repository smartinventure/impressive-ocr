// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLogs,
  LOG_FILE_NAME,
  PREVIOUS_LOG_FILE_NAME,
  readLogTail,
  RotatingLogFile,
} from './log-file';

/**
 * The log exists so a user without a terminal can see why their documents are failing. That
 * makes two things load-bearing: it must not grow without bound, and reading it back must not
 * hand the browser 30 MB.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'impressive-ocr-log-'));
});

describe('RotatingLogFile', () => {
  it('writes lines to the log', () => {
    const file = new RotatingLogFile({ directory });
    file.write('{"msg":"first"}\n');
    file.write('{"msg":"second"}\n');
    file.close();

    return expect(readFile(join(directory, LOG_FILE_NAME), 'utf8')).resolves.toContain('second');
  });

  it('rotates once the cap is passed, keeping one previous generation', async () => {
    const file = new RotatingLogFile({ directory, maxBytes: 200 });
    for (let index = 0; index < 40; index += 1) {
      file.write(`{"msg":"line ${index} padded out to make this worth counting"}\n`);
    }
    file.close();

    // Both files exist, and the live one is small again.
    await expect(stat(join(directory, PREVIOUS_LOG_FILE_NAME))).resolves.toBeTruthy();
    const current = await stat(join(directory, LOG_FILE_NAME));
    expect(current.size).toBeLessThan(400);
  });

  it('bounds total disk use at roughly twice the cap', async () => {
    const file = new RotatingLogFile({ directory, maxBytes: 500 });
    for (let index = 0; index < 500; index += 1) {
      file.write(`{"msg":"${'x'.repeat(80)}"}\n`);
    }
    file.close();

    const sizes = await Promise.all(
      [LOG_FILE_NAME, PREVIOUS_LOG_FILE_NAME].map(async (name) => {
        try {
          return (await stat(join(directory, name))).size;
        } catch {
          return 0;
        }
      }),
    );

    // Without rotation this would be ~45 KB. Two generations is the whole retention policy.
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(500 * 2 + 200);
  });

  it('appends to an existing file rather than truncating on restart', async () => {
    const first = new RotatingLogFile({ directory });
    first.write('{"msg":"before restart"}\n');
    first.close();

    const second = new RotatingLogFile({ directory });
    second.write('{"msg":"after restart"}\n');
    second.close();

    // A restart is exactly when the preceding lines matter most.
    const text = await readFile(join(directory, LOG_FILE_NAME), 'utf8');
    expect(text).toContain('before restart');
    expect(text).toContain('after restart');
  });

  it('never throws, whatever the filesystem does', () => {
    // A directory that cannot be created must cost the log, not the OCR run in progress.
    const file = new RotatingLogFile({ directory: join(directory, 'a-file-not-a-dir', 'nested') });
    expect(() => file.write('{"msg":"x"}\n')).not.toThrow();
  });
});

describe('readLogTail', () => {
  it('is empty and untruncated when nothing has been logged', async () => {
    expect(await readLogTail(directory)).toEqual({ text: '', truncated: false, totalBytes: 0 });
  });

  it('returns the whole file when it is small', async () => {
    await writeFile(join(directory, LOG_FILE_NAME), 'one\ntwo\n');

    const tail = await readLogTail(directory);
    expect(tail.text).toBe('one\ntwo\n');
    expect(tail.truncated).toBe(false);
  });

  it('returns only the end of a large file, and says so', async () => {
    const line = `{"msg":"${'y'.repeat(90)}"}\n`;
    await writeFile(join(directory, LOG_FILE_NAME), line.repeat(200));

    const tail = await readLogTail(directory, 2_000);

    expect(tail.truncated).toBe(true);
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(2_000);
    // The newest lines are what matter; anything actionable is at the end.
    expect(tail.text.endsWith('}\n')).toBe(true);
  });

  it('never starts mid-record, which would be unparseable', async () => {
    const line = `{"msg":"${'z'.repeat(90)}"}\n`;
    await writeFile(join(directory, LOG_FILE_NAME), line.repeat(200));

    const tail = await readLogTail(directory, 2_000);

    expect(tail.text.startsWith('{')).toBe(true);
  });
});

describe('clearLogs', () => {
  it('removes both generations', async () => {
    await writeFile(join(directory, LOG_FILE_NAME), 'x');
    await writeFile(join(directory, PREVIOUS_LOG_FILE_NAME), 'y');

    await clearLogs(directory);

    await expect(stat(join(directory, LOG_FILE_NAME))).rejects.toThrow();
    await expect(stat(join(directory, PREVIOUS_LOG_FILE_NAME))).rejects.toThrow();
  });

  it('is untroubled by there being nothing to clear', async () => {
    await expect(clearLogs(directory)).resolves.toBeUndefined();
  });
});
