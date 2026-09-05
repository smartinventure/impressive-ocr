// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseVersion } from './version-order';

describe('parseVersion', () => {
  it('reads a plain semver version', () => {
    expect(parseVersion('1.2.3')).toEqual({ numbers: [1, 2, 3], preRelease: '' });
  });

  it('tolerates the leading v the release tags carry', () => {
    expect(parseVersion('v1.2.3')).toEqual({ numbers: [1, 2, 3], preRelease: '' });
  });

  it('keeps a pre-release suffix', () => {
    expect(parseVersion('1.2.3-rc.1')).toEqual({ numbers: [1, 2, 3], preRelease: 'rc.1' });
  });

  it.each(['', 'latest', '1.2', '1.2.3.4', 'v', 'not-a-version'])(
    'returns null for %o',
    (value) => {
      expect(parseVersion(value)).toBeNull();
    },
  );
});

describe('isNewerVersion', () => {
  it.each([
    ['1.0.7', '1.0.6'],
    ['1.1.0', '1.0.6'],
    ['2.0.0', '1.9.9'],
    ['v1.0.7', '1.0.6'],
  ])('offers %s to an installation running %s', (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(true);
  });

  it.each([
    ['1.0.6', '1.0.6'],
    ['1.0.5', '1.0.6'],
    ['1.0.9', '1.1.0'],
    ['0.9.9', '1.0.0'],
  ])('does not offer %s to an installation running %s', (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(false);
  });

  it('compares each component numerically, not as text', () => {
    // The string comparison every hand-rolled version check gets wrong: '10' sorts before
    // '9' alphabetically, so a lexical implementation would refuse this upgrade.
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('treats a final release as newer than its own pre-release', () => {
    expect(isNewerVersion('1.1.0', '1.1.0-rc.1')).toBe(true);
  });

  it('never offers a pre-release to an installation running the final version', () => {
    // allowPrerelease is off in the desktop updater; the server must agree with it.
    expect(isNewerVersion('1.1.0-rc.1', '1.1.0')).toBe(false);
    expect(isNewerVersion('1.2.0-rc.1', '1.1.0')).toBe(true);
  });

  it('refuses to conclude anything from an unparseable version', () => {
    // The failure that matters: a feed returning "latest" as a tag must not read as an
    // upgrade, or every installation offers an update forever.
    expect(isNewerVersion('latest', '1.0.6')).toBe(false);
    expect(isNewerVersion('1.0.7', 'unknown')).toBe(false);
  });
});
