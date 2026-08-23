// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builds the headless server distribution — no Electron, just Node, the built SPA and the
 * sidecar source.
 *
 *   node deploy/package-server.mjs --arch x64                 # dist/release/*.tar.gz
 *   node deploy/package-server.mjs --arch x64 --stage-only out/srv
 *
 * `--stage-only` writes the payload tree and stops before archiving. The container image
 * build uses it, so the tarball and the image are assembled by one piece of code: a layout
 * that drifts between the two is a bug that only appears in whichever of them is tested
 * less.
 *
 * The tarball is portable across architectures on purpose. The single native dependency,
 * better-sqlite3, ships every platform's prebuilt binary inside its own package and picks
 * one at runtime (`lib/binding.js`), musl included — so there is nothing here to
 * cross-compile.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requirePackage = createRequire(import.meta.url);

/** Architectures the launcher and the bundled prebuilds actually cover. */
const SUPPORTED_ARCHS = ['x64', 'arm64'];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : args[index + 1];
  };
  const arch = read('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
  if (!SUPPORTED_ARCHS.includes(arch)) {
    fail(`Unsupported --arch "${arch}". Expected one of: ${SUPPORTED_ARCHS.join(', ')}`);
  }
  return { arch, stageOnly: read('--stage-only', null) };
}

function readVersion() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
}

/**
 * Fail loudly and specifically on a missing input.
 *
 * These are all produced by earlier steps, and an archive that is silently missing its SPA
 * or its migrations still builds, still uploads, and only fails on a user's machine.
 */
function requireInput(relativePath, hint) {
  const absolute = join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    fail(`Missing ${relativePath}\n  ${hint}`);
  }
  return absolute;
}

/** Caches, virtualenvs and compiled Python never belong in a release archive. */
function isSidecarNoise(path) {
  return /(^|[\\/])(\.venv|__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache)([\\/]|$)/.test(
    path,
  );
}

function buildServerBundle() {
  process.stdout.write('Bundling the server…\n');
  execFileSync(process.execPath, [join(repoRoot, 'apps', 'server', 'build.mjs')], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

/**
 * Copy better-sqlite3 in, minus everything only its compile step needs.
 *
 * `prebuilds/` is the whole point — it holds the `.node` for every platform, so this copy is
 * what makes one archive work on glibc, musl, x64 and arm64 alike. `build/`, `deps/` and
 * `src/` are the C++ sources and a local compile: tens of megabytes that nothing reads at
 * runtime.
 */
function copyBetterSqlite(serverDir) {
  const manifest = requirePackage.resolve('better-sqlite3/package.json', {
    paths: [join(repoRoot, 'apps', 'server'), join(repoRoot, 'packages', 'db'), repoRoot],
  });
  const source = dirname(manifest);
  const target = join(serverDir, 'node_modules', 'better-sqlite3');
  mkdirSync(target, { recursive: true });

  for (const entry of ['lib', 'prebuilds', 'package.json', 'LICENSE']) {
    const from = join(source, entry);
    if (!existsSync(from)) {
      fail(`better-sqlite3 is missing ${entry} at ${source}`);
    }
    cpSync(from, join(target, entry), { recursive: true });
  }
}

/**
 * A POSIX launcher that makes the payload self-locating, so nothing has to be configured
 * before `bin/impressive-ocr-server` works.
 *
 * Every value stays overridable: a container image, a systemd unit or an administrator may
 * well put the data directory somewhere else entirely.
 */
const LAUNCHER = [
  '#!/bin/sh',
  '# SPDX-License-Identifier: AGPL-3.0-or-later',
  '#',
  '# Resolves every path relative to this file, so the archive runs from wherever it was',
  '# unpacked. Set any of these in the environment to override.',
  'set -eu',
  '',
  'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
  'root=$(CDPATH= cd -- "$here/.." && pwd)',
  '',
  'export IMPRESSIVE_OCR_WEB_ROOT="${IMPRESSIVE_OCR_WEB_ROOT:-$root/web}"',
  'export IMPRESSIVE_OCR_MIGRATIONS_DIR="${IMPRESSIVE_OCR_MIGRATIONS_DIR:-$root/migrations}"',
  'export IMPRESSIVE_OCR_SIDECAR_DIR="${IMPRESSIVE_OCR_SIDECAR_DIR:-$root/sidecar}"',
  'export IMPRESSIVE_OCR_UV_BINARY="${IMPRESSIVE_OCR_UV_BINARY:-$root/uv/uv}"',
  '',
  'exec node "$root/server/main.cjs" "$@"',
  '',
].join('\n');

function stage(root, version, arch) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const serverDir = join(root, 'server');
  mkdirSync(serverDir, { recursive: true });

  const bundle = requireInput('apps/server/dist/main.cjs', 'The bundle step should have run.');
  cpSync(bundle, join(serverDir, 'main.cjs'));

  // Shipped deliberately: an AGPL product benefits far more from a readable stack trace in a
  // bug report than from the megabyte saved by withholding it.
  const sourceMap = join(repoRoot, 'apps', 'server', 'dist', 'main.cjs.map');
  if (existsSync(sourceMap)) {
    cpSync(sourceMap, join(serverDir, 'main.cjs.map'));
  }

  copyBetterSqlite(serverDir);

  cpSync(
    requireInput('apps/web/dist', 'Run: pnpm --filter @impressive-ocr/web build'),
    join(root, 'web'),
    { recursive: true },
  );
  cpSync(
    requireInput('packages/db/migrations', 'Run: pnpm db:generate'),
    join(root, 'migrations'),
    { recursive: true },
  );
  cpSync(
    requireInput('sidecar', 'The sidecar source is part of the repository.'),
    join(root, 'sidecar'),
    { recursive: true, filter: (source) => !isSidecarNoise(source) },
  );
  cpSync(
    requireInput(
      `vendor/uv-${arch}`,
      `Run: node deploy/fetch-uv.mjs --target server --arch ${arch}`,
    ),
    join(root, 'uv'),
    { recursive: true },
  );

  for (const file of ['LICENSE', 'NOTICE']) {
    cpSync(join(repoRoot, file), join(root, file));
  }

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, 'impressive-ocr-server');
  writeFileSync(launcher, LAUNCHER);

  writeFileSync(
    join(root, 'VERSION'),
    `impressive-ocr-server ${version}\nlinux-${arch}\nnode >=22.12.0 required\n`,
  );

  if (process.platform === 'win32') {
    // tar on Windows cannot record a POSIX mode bit that NTFS never stored. A release built
    // here would extract without an executable launcher, so say so rather than ship it.
    process.stderr.write(
      'Warning: packaging on Windows loses the executable bit on bin/ and uv/. ' +
        'Release archives must be built on Linux.\n',
    );
    return;
  }

  chmodSync(launcher, 0o755);
  const uv = join(root, 'uv', 'uv');
  if (existsSync(uv)) {
    chmodSync(uv, 0o755);
  }
}

function archive(stagingParent, folder, outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });

  // Run from the staging directory and name the archive relative to it.
  //
  // Not a style preference: GNU tar reads an `-f` argument containing a colon as
  // `host:path` for a remote tape drive, so an absolute Windows path turns into an attempt
  // to reach a machine called "D". Relative paths have no colon to misread, and are equally
  // correct on Linux, where the release actually gets built.
  const relativeOut = relative(stagingParent, outFile).replace(/\\/g, '/');

  // The platform's own tar: Linux, macOS and Windows 10+ all ship one, and pulling in a Node
  // tar implementation for a single build-time call would be gratuitous.
  execFileSync('tar', ['-czf', relativeOut, folder], {
    cwd: stagingParent,
    stdio: 'inherit',
  });
}

function main() {
  const { arch, stageOnly } = parseArgs();
  const version = readVersion();
  const name = `impressive-ocr-server-${version}-linux-${arch}`;

  buildServerBundle();

  if (stageOnly !== null) {
    const root = resolve(process.cwd(), stageOnly);
    stage(root, version, arch);
    process.stdout.write(`Staged the server payload at ${root}\n`);
    return;
  }

  const stagingParent = join(repoRoot, 'dist', 'server-staging');
  const root = join(stagingParent, name);
  stage(root, version, arch);

  const outFile = join(repoRoot, 'dist', 'release', `${name}.tar.gz`);
  archive(stagingParent, name, outFile);
  rmSync(stagingParent, { recursive: true, force: true });

  process.stdout.write(`Packaged ${outFile}\n`);
}

main();
