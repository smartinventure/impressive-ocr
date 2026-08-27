// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundles the headless server into a single file.
 *
 * esbuild rather than `tsc`, for the same reason the Electron main process uses it: the
 * server imports `@impressive-ocr/db` and `@impressive-ocr/shared` as raw TypeScript source
 * from the workspace. `tsc` would emit imports of `@impressive-ocr/db` that resolve to
 * nothing once the package is pruned out of a container image, and project references would
 * mean maintaining a second build graph for no gain.
 *
 *   node apps/server/build.mjs
 *   node apps/server/build.mjs --watch
 */

import { context, build as esbuild } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
const watch = process.argv.includes('--watch');

/**
 * `better-sqlite3` is a native addon: bundling its JS loader breaks the relative lookup it
 * does for the compiled `.node`. It is installed alongside the bundle instead.
 */
const external = ['better-sqlite3'];

/**
 * Licence values to compile in, as an esbuild `define` for `__LICENSE_BUILD__`.
 *
 * Emitted only when something is actually set, so a local build leaves the symbol undefined
 * and `app.ts` falls through to its own defaults. `typeof` on an undeclared identifier is
 * legal JavaScript, which is what makes the absent case safe rather than a ReferenceError.
 */
function licenseBuildDefaults() {
  const values = {
    personalProduct: process.env.IMPRESSIVE_OCR_LICENSE_PRODUCT_PERSONAL,
    personalKey: process.env.IMPRESSIVE_OCR_LICENSE_KEY_PERSONAL,
    commercialProduct: process.env.IMPRESSIVE_OCR_LICENSE_PRODUCT_COMMERCIAL,
    commercialKey: process.env.IMPRESSIVE_OCR_LICENSE_KEY_COMMERCIAL,
  };

  const present = Object.fromEntries(
    Object.entries(values).filter(([, value]) => (value ?? '') !== ''),
  );
  return Object.keys(present).length === 0
    ? {}
    : { __LICENSE_BUILD__: JSON.stringify(present) };
}

/**
 * CommonJS, matching the Electron bundle.
 *
 * `infra/module-paths.ts` branches on `__dirname` versus `import.meta.url` precisely so one
 * source tree can be loaded both ways; emitting CJS keeps the native `require` of
 * better-sqlite3 a plain `require` rather than an ESM shim.
 */
const options = {
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: join(outDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // Not minified: this is AGPL software, and a readable stack trace in a bug report from a
  // real install is worth more than the saved kilobytes.
  minify: false,
  logLevel: 'info',
  external,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    // Licence configuration, compiled in as a *fallback* rather than over `process.env`.
    //
    // The headless tarball has nowhere else to get it: it is unpacked and run, with no image
    // to carry `ENV` and no operator who should have to be told two secret variables. The
    // container has the opposite need — its values come from `ENV` and must stay overridable,
    // which is why this is a separate symbol and not a substitution of the env read itself.
    // Defining `process.env.…` directly would freeze the container's values at build time.
    ...licenseBuildDefaults(),
  },
  logOverride: {
    // `module-paths.ts` keeps both branches deliberately. In this CJS bundle `__dirname`
    // wins and the import.meta branch is dead code — silenced so it cannot mask a real
    // warning.
    'empty-import-meta': 'silent',
  },
};

async function main() {
  rmSync(outDir, { recursive: true, force: true });

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    process.stdout.write('Watching the server bundle…\n');
    return;
  }

  await esbuild(options);
  process.stdout.write('Built the server bundle.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
