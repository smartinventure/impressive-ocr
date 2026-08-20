// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { beginTracking, looksTemporary, observe } from './file-stability';

const WINDOW = 2_000;

describe('observe', () => {
  it('reports waiting while the window has not elapsed', () => {
    const candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    const result = observe(candidate, { sizeBytes: 100, modifiedAtMs: 1 }, 500, WINDOW);

    expect(result.verdict).toEqual({ kind: 'waiting', remainingMs: 1_500 });
  });

  it('reports stable once the file has been unchanged for the whole window', () => {
    const candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    const result = observe(candidate, { sizeBytes: 100, modifiedAtMs: 1 }, 2_000, WINDOW);

    expect(result.verdict.kind).toBe('stable');
  });

  it('restarts the clock when the file is still growing', () => {
    // The critical case: a 200 MB scan copying over SMB must not be declared stable just
    // because the *first* sighting was long enough ago.
    const candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    const result = observe(candidate, { sizeBytes: 200, modifiedAtMs: 5 }, 1_900, WINDOW);

    expect(result.verdict.kind).toBe('still-changing');
    expect(result.next.unchangedSinceMs).toBe(1_900);
    expect(result.next.last.sizeBytes).toBe(200);
  });

  it('does not become stable until the window elapses after the last change', () => {
    let candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    candidate = observe(candidate, { sizeBytes: 200, modifiedAtMs: 5 }, 1_900, WINDOW).next;
    const tooSoon = observe(candidate, { sizeBytes: 200, modifiedAtMs: 5 }, 3_000, WINDOW);
    const longEnough = observe(candidate, { sizeBytes: 200, modifiedAtMs: 5 }, 3_900, WINDOW);

    expect(tooSoon.verdict.kind).toBe('waiting');
    expect(longEnough.verdict.kind).toBe('stable');
  });

  it('detects a rewrite that keeps the same size', () => {
    // Same byte count, new mtime — a re-scan saved over the original.
    const candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    const result = observe(candidate, { sizeBytes: 100, modifiedAtMs: 99 }, 1_000, WINDOW);

    expect(result.verdict.kind).toBe('still-changing');
  });

  it('reports vanished when the file is gone', () => {
    const candidate = beginTracking('a.pdf', { sizeBytes: 100, modifiedAtMs: 1 }, 0);

    expect(observe(candidate, null, 1_000, WINDOW).verdict.kind).toBe('vanished');
  });

  it('treats a zero-byte file like any other', () => {
    // Scanners sometimes create the file before writing it; it is stable only if it stays
    // empty for the full window, at which point it is a real (if useless) file.
    const candidate = beginTracking('a.pdf', { sizeBytes: 0, modifiedAtMs: 1 }, 0);

    expect(observe(candidate, { sizeBytes: 0, modifiedAtMs: 1 }, 2_500, WINDOW).verdict.kind).toBe(
      'stable',
    );
  });
});

describe('looksTemporary', () => {
  it.each([
    '~$report.docx',
    '.~lock.scan.pdf',
    'scan.pdf.tmp',
    'invoice.pdf.crdownload',
    'batch.partial',
    'upload.part',
  ])('rejects %s', (name) => {
    expect(looksTemporary(name)).toBe(true);
  });

  it.each(['invoice.pdf', 'Rechnung 2024-01.pdf', 'scan~1.pdf', 'report.temporary.pdf'])(
    'accepts %s',
    (name) => {
      expect(looksTemporary(name)).toBe(false);
    },
  );
});
