// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Comparing two release versions, without a semver dependency.
 *
 * The only question asked anywhere in this module is "is the published version newer than the
 * one running", over versions this project's own release script writes. Those are always
 * `major.minor.patch`, so the full semver grammar — ranges, build metadata, caret and tilde
 * operators — would be several hundred kilobytes of dependency answering a question three
 * integer comparisons answer.
 *
 * Pre-release suffixes are the one part of the grammar that is honoured, because
 * `allowPrerelease` is off in the desktop updater and the server must agree with it: 1.1.0 is
 * newer than 1.1.0-rc.1, and an installation running the release must not be told that the
 * release candidate it precedes is an upgrade.
 */

interface ParsedVersion {
  readonly numbers: readonly number[];
  /** Empty for a final release, which sorts above any pre-release of the same numbers. */
  readonly preRelease: string;
}

/** Tolerates a leading `v`, which is how the tags are written. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (match === null) return null;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    preRelease: match[4] ?? '',
  };
}

/**
 * Whether `candidate` is a release worth offering to someone running `current`.
 *
 * False when either side is unparseable. An unrecognised version is not evidence of an
 * upgrade, and offering one on the strength of a string nobody could read is how an
 * installation ends up downgrading itself.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (next === null || now === null) return false;

  for (let index = 0; index < next.numbers.length; index += 1) {
    const a = next.numbers[index] ?? 0;
    const b = now.numbers[index] ?? 0;
    if (a !== b) return a > b;
  }

  // Same numbers. A final release beats a pre-release of those numbers; nothing else counts
  // as an upgrade, so two pre-releases of the same version are treated as equal rather than
  // ordered against each other.
  return next.preRelease === '' && now.preRelease !== '';
}
