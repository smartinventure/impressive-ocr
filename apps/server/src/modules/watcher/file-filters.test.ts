// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { sourceOptionsSchema, type SourceOptions } from '@impressive-ocr/shared';
import { globToRegExp, matchesFilters, normalizeRelativePath } from './file-filters';

function source(overrides: Partial<SourceOptions> = {}): SourceOptions {
  return { ...sourceOptionsSchema.parse({ inputPath: 'D:\\in' }), ...overrides };
}

describe('globToRegExp', () => {
  it('matches a plain extension pattern', () => {
    expect(globToRegExp('*.pdf').test('invoice.pdf')).toBe(true);
    expect(globToRegExp('*.pdf').test('invoice.png')).toBe(false);
  });

  it('does not let a single star cross a directory boundary', () => {
    expect(globToRegExp('*.pdf').test('sub/invoice.pdf')).toBe(false);
  });

  it('matches at any depth with a double star, including zero directories', () => {
    // The default pattern is `**/*.pdf`; if it failed to match a file at the root, every
    // pipeline would silently ignore the top level of its own input folder.
    const pattern = globToRegExp('**/*.pdf');

    expect(pattern.test('invoice.pdf')).toBe(true);
    expect(pattern.test('2024/q1/invoice.pdf')).toBe(true);
  });

  it('matches a whole subtree', () => {
    expect(globToRegExp('archive/**').test('archive/2024/old.pdf')).toBe(true);
    expect(globToRegExp('archive/**').test('inbox/new.pdf')).toBe(false);
  });

  it('is case-insensitive, because Windows paths are', () => {
    expect(globToRegExp('**/*.pdf').test('SCAN.PDF')).toBe(true);
  });

  it('treats dots literally rather than as a wildcard', () => {
    expect(globToRegExp('*.pdf').test('invoiceXpdf')).toBe(false);
  });

  it('supports a single-character wildcard', () => {
    expect(globToRegExp('scan-?.pdf').test('scan-1.pdf')).toBe(true);
    expect(globToRegExp('scan-?.pdf').test('scan-12.pdf')).toBe(false);
  });

  it('supports character classes', () => {
    expect(globToRegExp('scan-[0-9].pdf').test('scan-7.pdf')).toBe(true);
    expect(globToRegExp('scan-[0-9].pdf').test('scan-a.pdf')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    expect(globToRegExp('report (final).pdf').test('report (final).pdf')).toBe(true);
    expect(globToRegExp('report (final).pdf').test('report final.pdf')).toBe(false);
  });
});

describe('normalizeRelativePath', () => {
  it('converts Windows separators so patterns can use forward slashes', () => {
    expect(normalizeRelativePath('2024\\q1\\invoice.pdf')).toBe('2024/q1/invoice.pdf');
  });
});

describe('matchesFilters', () => {
  it('accepts a PDF under the default patterns', () => {
    expect(matchesFilters('invoice.pdf', source())).toBe(true);
  });

  it('accepts a nested PDF under the default patterns', () => {
    expect(matchesFilters('2024\\q1\\invoice.pdf', source())).toBe(true);
  });

  it('rejects a file type that is not included', () => {
    expect(matchesFilters('notes.docx', source())).toBe(false);
  });

  it('rejects the Office lock files the defaults exclude', () => {
    expect(matchesFilters('~$invoice.pdf', source())).toBe(false);
  });

  it('lets an exclusion override a matching inclusion', () => {
    // A user adding `archive/**` expects it to win over the broad include pattern.
    const options = source({ excludeGlobs: ['archive/**'] });

    expect(matchesFilters('archive/2024/old.pdf', options)).toBe(false);
    expect(matchesFilters('inbox/new.pdf', options)).toBe(true);
  });

  it('accepts everything when no include patterns are set', () => {
    expect(matchesFilters('anything.xyz', source({ includeGlobs: [], excludeGlobs: [] }))).toBe(
      true,
    );
  });

  it('still applies exclusions when there are no inclusions', () => {
    const options = source({ includeGlobs: [], excludeGlobs: ['**/*.tmp'] });

    expect(matchesFilters('scan.tmp', options)).toBe(false);
    expect(matchesFilters('scan.pdf', options)).toBe(true);
  });
});
