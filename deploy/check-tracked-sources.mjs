// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Fail if any source file is excluded from the repository, or holds a raw control byte.
 *
 * This exists because it already happened, silently, for weeks. `.gitignore` carried
 * `runtime/`, `logs/` and `build/` without a leading slash, and git matches an unanchored
 * pattern at *any* depth — so three real directories were never committed:
 *
 *     apps/server/src/modules/runtime/   the GPU probe, installer, wheel index — 18 files
 *     apps/web/src/features/logs/        the log viewer
 *     apps/desktop/build/                icons, entitlements, the NSIS script
 *
 * Nothing complained. `git status` was clean, every check passed, and the code simply was not
 * in the repository. It surfaced only when somebody cloned it onto another machine and found
 * a module that did not exist.
 *
 * A clean `git status` cannot catch this, because an ignored file is not untracked — it is
 * invisible. Asking git directly is the only way.
 */

/** Git separates paths with a plain newline. */
const NEWLINE = String.fromCharCode(10);

/** Directories that hold code we always intend to ship. */
const SOURCE_ROOTS = ['apps', 'packages', 'sidecar/src', 'sidecar/tests', 'deploy', 'dev'];

/** Genuinely generated or vendored, and correctly ignored inside those roots. */
const LEGITIMATELY_IGNORED = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)out(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.ruff_cache(\/|$)/,
  /(^|\/)\.mypy_cache(\/|$)/,
  /\.egg-info(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.run(\/|$)/,
  /(^|\/)dev\.env$/,
  /\.tsbuildinfo$/,
  /\.log$/,
];

/** File types worth shipping. A stray `.tmp` inside a source tree is not a problem. */
const SOURCE_EXTENSIONS =
  /\.(ts|tsx|js|mjs|cjs|vue|py|json|yml|yaml|css|scss|html|md|sql|png|ico|icns|svg|plist|nsh|ttf|txt|sh|ps1)$/i;

/**
 * `--directory` collapses a wholly-ignored directory to one entry.
 *
 * Without it this enumerates every file in every `node_modules`, which is hundreds of
 * thousands of paths and overflows the subprocess buffer outright.
 */
const listed = execFileSync(
  'git',
  ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...SOURCE_ROOTS],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
)
  .split(NEWLINE)
  .filter(Boolean)
  .filter((path) => !LEGITIMATELY_IGNORED.some((pattern) => pattern.test(path)));

/**
 * A collapsed directory has to be expanded to see whether it holds source.
 *
 * `apps/server/src/modules/runtime/` arrives as one entry; the eighteen files inside it are
 * the actual finding.
 */
const ignored = listed.flatMap((entry) => {
  if (!entry.endsWith('/')) {
    return SOURCE_EXTENSIONS.test(entry) ? [entry] : [];
  }

  const inside = execFileSync(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', entry],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
    .split(NEWLINE)
    .filter(Boolean);

  return inside
    .filter((path) => SOURCE_EXTENSIONS.test(path))
    .filter((path) => !LEGITIMATELY_IGNORED.some((pattern) => pattern.test(path)));
});

let failed = false;

if (ignored.length > 0) {
  failed = true;
  console.error('These source files are excluded from the repository by .gitignore:\n');
  for (const path of ignored.slice(0, 40)) {
    console.error(`  ${path}`);
  }
  if (ignored.length > 40) {
    console.error(`  ... and ${ignored.length - 40} more`);
  }
  console.error(
    '\nUsually an unanchored .gitignore pattern: `runtime/` matches at any depth, ' +
      '`/runtime/` only at the root.\n' +
      'Check with: git check-ignore -v <path>',
  );
}

/**
 * Fail if a text source carries a raw control byte.
 *
 * Three files did: a heredoc wrote real 0x00, 0x07 and 0x1b bytes where the source meant the
 * escapes, so `[\x00-\x1f]` in a regex and an ANSI sequence in a test were stored as the
 * characters themselves. The code behaved identically, which is why nobody noticed — but git
 * classifies such a file as *binary*, so it stops diffing it, stops normalizing its line
 * endings, and shows "Binary files differ" in every review of it.
 *
 * Tab, newline and carriage return are the only control characters a source file may hold.
 */
const TEXT_EXTENSIONS =
  /\.(ts|tsx|js|mjs|cjs|vue|py|json|yml|yaml|css|scss|html|sql|sh|ps1|nsh|plist|md|txt)$/i;
const ALLOWED_CONTROL_BYTES = new Set([9, 10, 13]);

const withControlBytes = execFileSync('git', ['ls-files', '--', ...SOURCE_ROOTS], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split(NEWLINE)
  .filter(Boolean)
  .filter((path) => TEXT_EXTENSIONS.test(path))
  .flatMap((path) => {
    const bytes = readFileSync(path);
    const offset = bytes.findIndex((byte) => byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte));
    if (offset < 0) {
      return [];
    }
    const line = bytes.subarray(0, offset).toString('utf8').split(NEWLINE).length;
    return [{ path, line, byte: bytes[offset] ?? 0 }];
  });

if (withControlBytes.length > 0) {
  failed = true;
  console.error('\nThese source files contain raw control bytes:\n');
  for (const finding of withControlBytes) {
    const hex = finding.byte.toString(16).padStart(2, '0');
    console.error(`  ${finding.path}:${finding.line}  0x${hex}`);
  }
  console.error(
    '\nAlmost always a heredoc that ate a backslash: the file was meant to hold the two ' +
      'characters of an escape, and holds the byte instead.\n' +
      'Git treats such a file as binary. Write the escape, not the character.',
  );
}

if (failed) {
  process.exit(1);
}

console.log('All source files are tracked, and none carries a raw control byte.');
