// SPDX-License-Identifier: AGPL-3.0-or-later
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates this module on disk, in both of the ways the server is loaded.
 *
 * Headless it runs as ESM (`tsx src/main.ts`, or a built ESM bundle), where `import.meta.url`
 * is set and `__dirname` does not exist. Inside Electron it is bundled to CommonJS, where the
 * reverse is true and esbuild rewrites `import.meta` to an empty object.
 *
 * Getting this wrong is not a crash but something worse: the paths silently resolve relative
 * to the wrong root, and the database migrates into a directory nobody looks at.
 *
 * The Electron host passes explicit paths anyway, so this is only the fallback.
 */
function moduleDirectory(): string {
  // Checked first: in the CommonJS bundle this is the correct answer, and `import.meta.url`
  // would be undefined.
  if (typeof __dirname === 'string') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * The repository root, walking up from `apps/server/src/infra`.
 *
 * Only meaningful when running from the workspace — a packaged build always supplies explicit
 * paths instead.
 */
export function repositoryRoot(): string {
  return resolve(moduleDirectory(), '..', '..', '..', '..');
}

export function defaultMigrationsDir(): string {
  return join(repositoryRoot(), 'packages', 'db', 'migrations');
}

export function defaultSidecarDir(): string {
  return join(repositoryRoot(), 'sidecar');
}

export function defaultWebRoot(): string {
  return join(repositoryRoot(), 'apps', 'web', 'dist');
}

export function defaultUvBinary(): string {
  return join(
    repositoryRoot(),
    'vendor',
    'uv',
    process.platform === 'win32' ? 'uv.exe' : 'uv',
  );
}
