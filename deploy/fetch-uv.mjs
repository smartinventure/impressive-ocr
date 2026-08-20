// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Downloads the pinned `uv` binary into `vendor/uv/`.
 *
 * `uv` is what installs Python and PaddleOCR on the user's machine at first run — the app
 * ships without either, because the GPU wheel alone is multiple gigabytes and bundling it
 * would mean a separate CPU and GPU installer per platform.
 *
 * Run by CI before packaging, and by developers who want the runtime bootstrap to work
 * locally:
 *
 *   node deploy/fetch-uv.mjs                          # this machine
 *   node deploy/fetch-uv.mjs --target win --arch x64  # a specific target
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Pinned deliberately: `uv` is what decides which Python and which PaddlePaddle wheel a user
 * ends up with, so it must not change under an existing install without a release.
 */
const UV_VERSION = '0.5.14';

/** Astral's release asset names, keyed by our target/arch pair. */
const ASSETS = {
  'win-x64': 'uv-x86_64-pc-windows-msvc.zip',
  'mac-x64': 'uv-x86_64-apple-darwin.tar.gz',
  'mac-arm64': 'uv-aarch64-apple-darwin.tar.gz',
  'linux-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
  'server-x64': 'uv-x86_64-unknown-linux-gnu.tar.gz',
  'server-arm64': 'uv-aarch64-unknown-linux-gnu.tar.gz',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : args[index + 1];
  };
  return {
    target: read('--target', defaultTarget()),
    arch: read('--arch', process.arch === 'arm64' ? 'arm64' : 'x64'),
    force: args.includes('--force'),
  };
}

function defaultTarget() {
  switch (process.platform) {
    case 'win32':
      return 'win';
    case 'darwin':
      return 'mac';
    default:
      return 'linux';
  }
}

async function main() {
  const { target, arch, force } = parseArgs();
  const key = `${target}-${arch}`;
  const asset = ASSETS[key];

  if (asset === undefined) {
    process.stderr.write(
      `No uv build for ${key}. Known targets: ${Object.keys(ASSETS).join(', ')}\n`,
    );
    process.exit(2);
  }

  const vendorDir = join(repoRoot, 'vendor', 'uv');
  const binaryName = target === 'win' ? 'uv.exe' : 'uv';
  const binaryPath = join(vendorDir, binaryName);

  if (existsSync(binaryPath) && !force) {
    process.stdout.write(`uv already present at ${binaryPath} (use --force to replace)\n`);
    return;
  }

  mkdirSync(vendorDir, { recursive: true });

  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  process.stdout.write(`Downloading ${asset} (uv ${UV_VERSION})…\n`);

  const archivePath = join(vendorDir, asset);
  await download(`${base}/${asset}`, archivePath);

  // Astral publishes a checksum per asset. Verifying it matters more than usual here: this
  // binary is about to install everything else on a user's machine.
  const expected = await fetchChecksum(`${base}/${asset}.sha256`);
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (expected !== null && expected !== actual) {
    rmSync(archivePath, { force: true });
    process.stderr.write(`Checksum mismatch for ${asset}\n  expected ${expected}\n  got      ${actual}\n`);
    process.exit(1);
  }

  extract(archivePath, vendorDir, asset);
  rmSync(archivePath, { force: true });

  if (target !== 'win') {
    chmodSync(binaryPath, 0o755);
  }

  writeFileSync(
    join(vendorDir, 'VERSION'),
    `${UV_VERSION}\n${key}\nsha256:${actual}\n`,
  );
  process.stdout.write(`uv ${UV_VERSION} ready at ${binaryPath}\n`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function fetchChecksum(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    process.stderr.write(`Warning: no checksum published at ${url}\n`);
    return null;
  }
  // Format is "<sha256>  <filename>".
  return (await response.text()).trim().split(/\s+/)[0] ?? null;
}

/**
 * Unpack with the platform's own tool.
 *
 * Windows and macOS both ship `tar`, and Windows ships `Expand-Archive`; adding a Node
 * unzip dependency for a build-time script would be gratuitous.
 */
function extract(archivePath, destination, asset) {
  if (asset.endsWith('.zip')) {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    return;
  }
  // --strip-components=1: the tarballs wrap the binary in a versioned directory.
  execFileSync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components=1'], {
    stdio: 'inherit',
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
