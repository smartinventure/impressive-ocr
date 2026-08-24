// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseVersions } from './runtime-installer';

/**
 * The System page reported "—" for Python and PaddleOCR on a working install.
 *
 * The verify step had always printed the versions; nothing read them back, so they were
 * computed and discarded. These pin the parsing so they cannot silently go missing again.
 */
describe('parseVersions', () => {
  const line =
    'IMPRESSIVE_OCR_VERSIONS {"python":"3.12.8","paddle":"3.0.0","paddleocr":"3.2.0","sidecar":"1.2.3"}';

  it('reads every version, the sidecar included', () => {
    expect(parseVersions(line)).toEqual({
      python: '3.12.8',
      paddle: '3.0.0',
      paddleocr: '3.2.0',
      sidecar: '1.2.3',
    });
  });

  it('reports an unknown sidecar rather than omitting it', () => {
    // A runtime installed before the sidecar version was reported prints null here. That must
    // read as "unknown" - which triggers the backfill - and never as "up to date".
    const older =
      'IMPRESSIVE_OCR_VERSIONS {"python":"3.12.8","paddle":"3.0.0","paddleocr":"3.2.0","sidecar":null}';

    expect(parseVersions(older)?.sidecar).toBeNull();
  });

  it('finds the payload even when something else printed on the same line', () => {
    // Warnings from a dependency routinely share a line with real output.
    expect(parseVersions(`some warning ${line}`)?.python).toBe('3.12.8');
  });

  it('ignores lines that are not the payload', () => {
    for (const other of ['', 'Models ready', 'Installed 42 packages', '{"python":"3.12"}']) {
      expect(parseVersions(other)).toBeNull();
    }
  });

  it('survives a truncated payload rather than failing the install', () => {
    expect(parseVersions('IMPRESSIVE_OCR_VERSIONS {"python":"3.12')).toBeNull();
  });

  it('treats a missing or blank field as unknown rather than inventing one', () => {
    const partial = 'IMPRESSIVE_OCR_VERSIONS {"python":"3.12.8","paddle":"  "}';

    expect(parseVersions(partial)).toEqual({
      python: '3.12.8',
      paddle: null,
      paddleocr: null,
      sidecar: null,
    });
  });
});
