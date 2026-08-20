// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundles the Electron main and preload scripts.
 *
 * esbuild rather than `tsc`, because the main process imports `@impressive-ocr/server` as raw
 * TypeScript source from the workspace. A bundle also means the packaged app has no
 * node_modules tree to walk at startup, which is the difference between a window appearing
 * immediately and a visible pause.
 */

import { context, build as esbuild } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
const watch = process.argv.includes('--watch');

/**
 * Modules that must NOT be bundled.
 *
 * `electron` is provided by the runtime. `better-sqlite3` is a native addon compiled against
 * Electron's own ABI — bundling its JS loader would break the `.node` lookup. Both are
 * resolved from the packaged node_modules instead.
 */
const external = [
  'electron',
  'better-sqlite3',
  // Also external, for a different reason: it is plain CommonJS with no `__esModule` marker,
  // so bundling it leaves esbuild's interop looking for a `.default` that does not exist.
  // Required from the packaged node_modules instead, where a named import resolves directly.
  'electron-updater',
];

/** CommonJS: Electron's main process still loads `main` as CJS. */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // Not minified: this is AGPL software, and a readable stack trace in a bug report from a
  // real install is worth far more than a few hundred kilobytes.
  minify: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

const targets = [
  {
    ...shared,
    entryPoints: [resolve(here, 'src/main/index.ts')],
    outfile: join(outDir, 'main.cjs'),
    external,
    logOverride: {
      // `infra/module-paths.ts` deliberately contains both an `import.meta.url` and a
      // `__dirname` branch, because the server is loaded as ESM headless and as CJS here.
      // In this bundle `__dirname` is defined and wins, so the import.meta branch is dead
      // code. Silenced so it cannot mask a genuine warning.
      'empty-import-meta': 'silent',
    },
  },
  {
    ...shared,
    entryPoints: [resolve(here, 'src/preload/index.ts')],
    outfile: join(outDir, 'preload.cjs'),
    // The preload runs in a sandboxed context with only `electron` available.
    external: ['electron'],
  },
];

async function main() {
  rmSync(outDir, { recursive: true, force: true });

  if (watch) {
    const contexts = await Promise.all(targets.map((options) => context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    process.stdout.write('Watching the Electron main and preload bundles…\n');
    return;
  }

  await Promise.all(targets.map((options) => esbuild(options)));
  process.stdout.write('Built the Electron bundles.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
