// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Writes one version number into every file that carries it.
 *
 * A single Node script rather than duplicated logic in the PowerShell and bash wrappers:
 * version drift between the app, the sidecar and the update feed is exactly the kind of bug
 * that only surfaces in a user's install, and two implementations would eventually disagree.
 *
 *   node deploy/set-version.mjs 1.2.3              write an explicit version
 *   node deploy/set-version.mjs --next patch       compute from the latest tag, and write it
 *   node deploy/set-version.mjs --next patch --print   compute and print only, write nothing
 *   node deploy/set-version.mjs --current          print the current version and exit
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file holding the version. Keep in step with the release checklist. */
const PACKAGE_FILES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'packages/shared/package.json',
  'packages/db/package.json',
  'packages/tsconfig/package.json',
];

const VERSION_TS = 'packages/shared/src/version.ts';
const PYPROJECT = 'sidecar/pyproject.toml';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function readCurrentVersion() {
  const path = join(repoRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return manifest.version;
}

/**
 * The newest `vX.Y.Z` tag, or null in a repository that has never released.
 *
 * Tags are the release ledger — not `package.json` — because a failed release may have left
 * the working tree bumped without a tag ever being pushed.
 */
function latestTag() {
  try {
    const output = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const first = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return first === undefined ? null : first.replace(/^v/, '');
  } catch {
    return null;
  }
}

function bump(version, level) {
  const match = SEMVER.exec(version);
  if (match === null) {
    throw new Error(`Cannot bump a non-semver version: ${version}`);
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  switch (level) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown bump level: ${level}`);
  }
}

/**
 * Replace one occurrence, failing only when the field is genuinely absent.
 *
 * The obvious test — did the text change? — conflates "no such field" with "already holds
 * this value", and the second is the normal case for the very first release: the tree already
 * says 1.0.0 and you ask for 1.0.0. That threw after every check had run, claiming
 * package.json had no version field, which it plainly did.
 *
 * Matching is the question actually being asked, so ask that.
 */
function replaceField(raw, pattern, replacement, missingMessage) {
  if (!pattern.test(raw)) {
    throw new Error(missingMessage);
  }
  return raw.replace(pattern, replacement);
}

function writeJsonVersion(relativePath, version) {
  const path = join(repoRoot, relativePath);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // apps/desktop does not exist until the Electron shell lands; skipping keeps the script
    // usable now rather than after that milestone.
    return false;
  }
  // Textual replacement rather than parse-and-stringify: rewriting the JSON would reorder
  // keys and reformat the whole file, burying the one-line change in every release diff.
  const updated = replaceField(
    raw,
    /("version"\s*:\s*)"[^"]*"/,
    `$1"${version}"`,
    `No version field found in ${relativePath}`,
  );
  writeFileSync(path, updated);
  return true;
}

function writeVersionTs(version) {
  const path = join(repoRoot, VERSION_TS);
  const raw = readFileSync(path, 'utf8');
  const updated = replaceField(
    raw,
    /(APP_VERSION = )'[^']*'/,
    `$1'${version}'`,
    `No APP_VERSION found in ${VERSION_TS}`,
  );
  writeFileSync(path, updated);
}

function writePyproject(version) {
  const path = join(repoRoot, PYPROJECT);
  const raw = readFileSync(path, 'utf8');
  // Anchored to the line so a dependency pin like `foo>=1.0.0` is never rewritten.
  const updated = replaceField(
    raw,
    /^version = "[^"]*"$/m,
    `version = "${version}"`,
    `No version found in ${PYPROJECT}`,
  );
  writeFileSync(path, updated);
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--current') {
    process.stdout.write(`${readCurrentVersion()}\n`);
    return;
  }

  let version;
  if (args[0] === '--next') {
    const level = args[1] ?? 'patch';
    // Base the bump on the newest *tag*, falling back to package.json for a repo with no
    // releases yet.
    const base = latestTag() ?? readCurrentVersion();
    version = bump(base, level);
  } else {
    version = args[0];
  }

  if (version === undefined || !SEMVER.test(version)) {
    process.stderr.write(
      'Usage: set-version.mjs <x.y.z> | --next [patch|minor|major] [--print] | --current\n',
    );
    process.exit(2);
  }

  // Lets a caller ask "what would the next version be?" without dirtying the tree — the
  // release script needs the number before it has decided to commit anything.
  if (args.includes('--print')) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const written = [];
  for (const file of PACKAGE_FILES) {
    if (writeJsonVersion(file, version)) {
      written.push(file);
    }
  }
  writeVersionTs(version);
  writePyproject(version);

  process.stdout.write(`${version}\n`);
  process.stderr.write(
    `Set version ${version} in ${written.length + 2} files (${VERSION_TS}, ${PYPROJECT} included)\n`,
  );
}

main();
