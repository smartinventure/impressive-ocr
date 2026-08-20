// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { expandTemplate, sanitizeStem, sourceStemOf } from './naming-template';

describe('expandTemplate', () => {
  it('substitutes the source name', () => {
    expect(expandTemplate('{name}', { sourceStem: 'invoice-4711' })).toBe('invoice-4711');
  });

  it('zero-pads the page number so per-page outputs sort correctly', () => {
    expect(expandTemplate('{name}_p{page}', { sourceStem: 'scan', page: 7 })).toBe('scan_p0007');
  });

  it('drops the page placeholder for whole-document formats', () => {
    expect(expandTemplate('{name}{page}', { sourceStem: 'scan' })).toBe('scan');
  });

  it('formats the date in local time', () => {
    const result = expandTemplate('{date}_{name}', {
      sourceStem: 'scan',
      date: new Date(2026, 7, 19, 0, 30),
    });

    // Local, not UTC: filing at 00:30 in Munich must not be stamped with yesterday.
    expect(result).toBe('2026-08-19_scan');
  });

  it('truncates the hash to twelve characters', () => {
    const result = expandTemplate('{name}_{hash}', {
      sourceStem: 'scan',
      contentHash: 'a'.repeat(64),
    });

    expect(result).toBe(`scan_${'a'.repeat(12)}`);
  });

  it('leaves unknown placeholders untouched', () => {
    expect(expandTemplate('{name}_{nope}', { sourceStem: 'scan' })).toBe('scan_{nope}');
  });
});

describe('sanitizeStem', () => {
  it('keeps spaces and hyphens, which ordinary filenames rely on', () => {
    expect(sanitizeStem('Invoice 2024-01')).toBe('Invoice 2024-01');
  });

  it('keeps umlauts and other non-ASCII letters', () => {
    expect(sanitizeStem('Rechnung Müller & Söhne')).toBe('Rechnung Müller & Söhne');
  });

  it('strips both path separators', () => {
    // The traversal guard: a source filename is chosen by whoever drops the file.
    expect(sanitizeStem('..\\..\\windows\\system32')).toBe('.._.._windows_system32');
    expect(sanitizeStem('../../etc/passwd')).toBe('.._.._etc_passwd');
  });

  it('strips the Windows-illegal punctuation', () => {
    expect(sanitizeStem('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it('strips control characters', () => {
    expect(sanitizeStem('doc\u0000\u001fname')).toBe('doc__name');
  });

  it('removes trailing dots and spaces that Windows would silently drop', () => {
    expect(sanitizeStem('report.  ')).toBe('report');
  });

  it('falls back to a placeholder when nothing usable remains', () => {
    expect(sanitizeStem('///')).toBe('___');
    expect(sanitizeStem('   ')).toBe('document');
  });

  it('escapes reserved Windows device names', () => {
    expect(sanitizeStem('CON')).toBe('CON_');
    expect(sanitizeStem('lpt1')).toBe('lpt1_');
  });

  it('truncates an absurdly long name', () => {
    expect(sanitizeStem('x'.repeat(500))).toHaveLength(120);
  });
});

describe('sourceStemOf', () => {
  it('drops the directory and the extension', () => {
    expect(sourceStemOf('D:\\scans\\invoice 4711.pdf')).toBe('invoice 4711');
  });

  it('keeps a name that has no extension', () => {
    expect(sourceStemOf('/data/scans/README')).toBe('README');
  });

  it('keeps only the final extension of a multi-dotted name', () => {
    expect(sourceStemOf('/data/archive.2024.pdf')).toBe('archive.2024');
  });

  it('never lets a separator survive into the stem', () => {
    // How much basename() strips is platform-dependent (Windows treats `\` as a separator,
    // POSIX does not), so assert the invariant that actually matters rather than one
    // platform's exact output.
    const stem = sourceStemOf('/data/..\\..\\evil.pdf');

    expect(stem).not.toContain('/');
    expect(stem).not.toContain('\\');
    expect(stem).toContain('evil');
  });
});
