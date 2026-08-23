// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Collects the build artifacts into one flat directory and adds the unversioned copies that
 * the `latest` download URLs need.
 *
 *   node deploy/make-stable-aliases.mjs artifacts --out upload
 *
 * GitHub serves `releases/latest/download/<asset-name>` as a permanent redirect to the
 * newest release — but only for an asset whose name never changes, so that name cannot carry
 * the version. `electron-updater` needs the exact opposite: `latest.yml` references its
 * installer by a versioned filename, and renaming it breaks the updater.
 *
 * So each release publishes both, and the rule is mechanical — copy every artifact to the
 * same name with the version segment removed:
 *
 *     Impressive-OCR-1.4.0-win-x64.exe   ->  Impressive-OCR-win-x64.exe
 *     impressive-ocr-server-1.4.0-linux-x64.tar.gz
 *                                        ->  impressive-ocr-server-linux-x64.tar.gz
 *
 * Copies, never renames: the versioned originals must survive, because they are what the
 * update feed points at.
 *
 * Flattening is the other half of the job. Artifacts arrive one directory per build, and a
 * GitHub release is a single flat list of assets — so two files that share a name would
 * quietly overwrite one another on upload. Better to fail here, with both paths named, than
 * to ship a release where the Linux asset is a macOS build.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Copied through, never aliased.
 *
 * The `latest*.yml` feeds already have stable names — that is how `electron-updater` finds
 * them — so an alias would be a second file competing for the same asset name.
 *
 * `.blockmap` files are addressed by their exact versioned name from inside `latest.yml`,
 * for differential downloads. An alias would never be read, and one left behind from an
 * earlier release is worse than none at all.
 */
const NEVER_ALIASED = /(^latest(-[a-z0-9]+)?\.yml$|\.blockmap$)/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const source = args[0];
  const outIndex = args.indexOf('--out');
  if (source === undefined || source.startsWith('--') || outIndex === -1) {
    fail('Usage: make-stable-aliases.mjs <artifacts-directory> --out <upload-directory>');
  }
  const out = args[outIndex + 1];
  if (out === undefined) {
    fail('--out needs a directory');
  }
  return { source, out };
}

function readVersion() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
}

/** Every file under `root`, at any depth — one directory per build arrives from CI. */
function walk(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The stable name, or null when the file carries no version segment.
 *
 * Anchored on the surrounding delimiter so that a version appearing incidentally elsewhere
 * in a filename is left alone.
 */
function stableName(base, version) {
  for (const [needle, replacement] of [
    [`-${version}-`, '-'],
    [`-${version}.`, '.'],
  ]) {
    if (base.includes(needle)) {
      return base.replace(needle, replacement);
    }
  }
  return null;
}

function main() {
  const { source, out } = parseArgs();

  const sourceRoot = resolve(process.cwd(), source);
  if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Not a directory: ${sourceRoot}`);
  }

  const outRoot = resolve(process.cwd(), out);
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  const version = readVersion();
  const files = walk(sourceRoot).filter((file) => !file.startsWith(outRoot));
  if (files.length === 0) {
    fail(`No artifacts found under ${sourceRoot}`);
  }

  /** Asset name -> the artifact path that claimed it. */
  const claimed = new Map();
  const published = [];
  let aliasCount = 0;

  const claim = (name, origin, kind) => {
    const previous = claimed.get(name);
    if (previous !== undefined) {
      fail(
        `Two artifacts both want the asset name "${name}":\n` +
          `  ${previous}\n  ${origin}\n` +
          'A GitHub release is one flat list of assets, so one would overwrite the other.',
      );
    }
    claimed.set(name, origin);
    published.push(`${kind}  ${name}`);
  };

  for (const file of files) {
    const relative = file.slice(sourceRoot.length + 1).replace(/\\/g, '/');
    const base = relative.slice(relative.lastIndexOf('/') + 1);

    claim(base, relative, 'asset ');
    copyFileSync(file, join(outRoot, base));

    if (NEVER_ALIASED.test(base)) {
      published.push(`        ${base} is an update feed; not aliased`);
      continue;
    }

    const stable = stableName(base, version);
    if (stable === null) {
      published.push(`        ${base} carries no version segment; not aliased`);
      continue;
    }

    claim(stable, `${relative} (alias)`, 'alias ');
    copyFileSync(file, join(outRoot, stable));
    aliasCount += 1;
  }

  if (aliasCount === 0) {
    fail(
      `Nothing was aliased: no artifact carried version ${version}.\n` +
        'The `latest` download links would all break, so this is never a correct release.',
    );
  }

  process.stdout.write(`Prepared ${claimed.size} assets for ${version} in ${outRoot}\n`);
  for (const line of published) {
    process.stdout.write(`  ${line}\n`);
  }
}

main();
