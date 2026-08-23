# deploy/

Release tooling.

Cutting a release, the build matrix, code signing and the `latest` download links are
described in the maintainers' notes, which are kept outside the published tree.

## Cutting a release

```powershell
./deploy/release.ps1                 # 1.0.0 -> 1.0.1
./deploy/release.ps1 -Level minor    # 1.0.1 -> 1.1.0
./deploy/release.ps1 -Version 2.0.0
./deploy/release.ps1 -DryRun
```

```bash
./deploy/release.sh                  # 1.0.0 -> 1.0.1
./deploy/release.sh minor
./deploy/release.sh --version 2.0.0
./deploy/release.sh --dry-run
```

Both do the same thing:

1. Refuse to continue on a dirty tree, off `main`, or behind `origin/main`.
2. Work out the next version **from the newest `v*` tag**, not from `package.json`.
3. Run lint, typecheck and the full test suite.
4. Write the version into every `package.json`, `packages/shared/src/version.ts` and
   `sidecar/pyproject.toml`.
5. Commit `release: vX.Y.Z`, create an **annotated** tag, push both.

Pushing the tag is what starts the build. Nothing here publishes anything itself.

## Why a tag, and not `[release]` in a commit message

| | Tag | `[release]` marker |
|---|---|---|
| Carries the version | yes | no — needs a second source of truth |
| Re-fires on revert / squash-merge / cherry-pick | no | yes |
| Re-runnable | yes — retag, or `workflow_dispatch` | no — needs a new commit |
| Visible as the release ledger | `git tag` | buried in history |

**GitHub does not auto-increment release numbers.** A release is named after whatever tag you
push. (`GITHUB_RUN_NUMBER` increments, but it is a build counter, not a version.) That is what
these scripts are for — the increment happens locally, from the tag list, under your control.

## Rebuilding a release without a new version

Use the workflow's manual trigger — Actions → Release → *Run workflow* — and give it the
existing tag. Useful when one platform's build failed for an infrastructure reason.

## The version must match the tag

The workflow verifies that `vX.Y.Z` equals the version in the tree and fails the release if
not. A mismatch would ship an app whose updater compares the wrong number against the release
feed, so it could never see itself as up to date. Always go through these scripts.

## Files

| File | Purpose |
|---|---|
| `release.ps1` / `release.sh` | Cut a release: bump, check, commit, tag, push |
| `set-version.mjs` | Writes one version into every file that carries it |
| `fetch-uv.mjs` | Downloads the pinned `uv` binary into `vendor/uv-<arch>/` |
| `package-server.mjs` | Builds the headless payload — a tarball, or `--stage-only` for the image |
| `make-stable-aliases.mjs` | Flattens the build artifacts and adds the `latest` copies |
| `check-tracked-sources.mjs` | Fails if a source file is excluded by `.gitignore` |
| `docker/Dockerfile` | The headless server image |
| `docker/docker-compose.yml` | A worked example for operators |

## Building the pieces by hand

Every CI step is one of these scripts, run the same way:

```sh
pnpm --filter @impressive-ocr/web build

node deploy/fetch-uv.mjs --target server --arch x64
node deploy/package-server.mjs --arch x64          # dist/release/*.tar.gz

docker build -f deploy/docker/Dockerfile -t impressive-ocr .
```

Build release archives on Linux — packaging on Windows cannot record the POSIX executable bit,
so the launcher inside the tarball comes out unrunnable. The script warns when it notices.
