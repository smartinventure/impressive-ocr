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
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');
/** The workspace root, two levels up from `apps/desktop`. */
const repoRoot = resolve(here, '..', '..');
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
    // Licence configuration, compiled in at build time.
    //
    // It cannot be read from the environment at runtime: the server reads `process.env` when
    // it starts, and that happens on the *user's* machine, where none of these are set. A
    // packaged desktop app has no environment to inherit, so the values have to travel inside
    // the bundle — which is what `define` does, substituting them as literals.
    //
    // Empty in a local build, which is a working app whose registration screen reports only
    // that it cannot reach the licence server. The release workflow supplies the real values
    // from repository secrets; they are never committed, because a key in a public repository
    // is scraped and revoked before the release it belongs to ships.
    ...licenseDefines(),
  },
};

/**
 * Licence values to compile in, as an esbuild `define` for `__LICENSE_BUILD__`.
 *
 * The same symbol the headless bundle uses, and for the same reason: `app.ts` looks these up
 * through `process.env[name]`, a *dynamic* property access that esbuild cannot substitute.
 * Defining `process.env.IMPRESSIVE_OCR_INSTALLER_KEY_COMMUNITY` therefore compiles cleanly,
 * changes nothing, and produces a desktop build that cannot activate a licence — which is
 * exactly what happened, and is invisible until someone types a correct key and is refused.
 *
 * Emitted only when something is set, so a local build leaves the symbol undefined and the
 * `typeof` guard in `app.ts` falls through to its defaults.
 */
/**
 * The licence text the Windows installer shows, written to `dist/`.
 *
 * The installer must display the AGPL, and the AGPL forbids altering its text -- so the
 * commercial position cannot be edited into `LICENSE` itself. This concatenates instead:
 * `LICENSING.txt`, which explains what the AGPL requires and when a commercial licence is
 * needed, followed by the licence in full and unmodified.
 *
 * Generated rather than committed, so the 661 lines of the AGPL exist once in this repository
 * and the installer can never show a copy that has drifted from `LICENSE`.
 */
function writeInstallerLicense() {
  const notice = readFileSync(join(repoRoot, 'LICENSING.txt'), 'utf8');
  const agpl = readFileSync(join(repoRoot, 'LICENSE'), 'utf8');
  const target = join(outDir, 'installer-license.txt');
  writeFileSync(
    target,
    `${notice}
${agpl}`,
    'utf8',
  );
  return target;
}

function licenseDefines() {
  const values = {
    personalProduct: process.env.IMPRESSIVE_OCR_PRODUCT_COMMUNITY,
    personalKey: process.env.IMPRESSIVE_OCR_INSTALLER_KEY_COMMUNITY,
    commercialProduct: process.env.IMPRESSIVE_OCR_PRODUCT_COMMERCIAL,
    commercialKey: process.env.IMPRESSIVE_OCR_INSTALLER_KEY_COMMERCIAL,
  };

  const present = Object.fromEntries(
    Object.entries(values).filter(([, value]) => (value ?? '') !== ''),
  );

  const defines = {};
  if (Object.keys(present).length > 0) {
    defines.__LICENSE_BUILD__ = JSON.stringify(present);
  }
  // Read statically in `app.ts`, so this one can still be substituted directly.
  if ((process.env.IMPRESSIVE_OCR_LICENSE_URL ?? '') !== '') {
    defines['process.env.IMPRESSIVE_OCR_LICENSE_URL'] = JSON.stringify(
      process.env.IMPRESSIVE_OCR_LICENSE_URL,
    );
  }
  return defines;
}

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
  // After the bundles, because `rmSync` above clears `dist/` and electron-builder reads
  // this path straight afterwards when packaging.
  writeInstallerLicense();
  process.stdout.write('Built the Electron bundles.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
