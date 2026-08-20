#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Cut a release of Impressive OCR.
#
# Bumps the version everywhere, commits, tags and pushes. Pushing the tag is what triggers the
# GitHub Actions release workflow — the tag is the release ledger, so nothing here publishes
# anything directly.
#
# Refuses to run on a dirty tree, off main, or behind the remote: a release built from a
# working copy nobody else can reproduce is worse than no release.
#
#   ./deploy/release.sh                  1.0.0 -> 1.0.1
#   ./deploy/release.sh minor            1.0.1 -> 1.1.0
#   ./deploy/release.sh --version 2.0.0
#   ./deploy/release.sh --dry-run
#   ./deploy/release.sh --skip-checks

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LEVEL="patch"
EXPLICIT_VERSION=""
SKIP_CHECKS=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major) LEVEL="$1"; shift ;;
    --version) EXPLICIT_VERSION="${2:-}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }

# --- Preconditions ----------------------------------------------------------

step 'Checking the working tree'

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Releases are cut from main; you are on '$BRANCH'." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo 'The working tree has uncommitted changes. Commit or stash them first.' >&2
  exit 1
fi

git fetch origin --tags --quiet
BEHIND="$(git rev-list --count HEAD..origin/main)"
if [[ "$BEHIND" != "0" ]]; then
  echo "Your branch is $BEHIND commit(s) behind origin/main. Pull first." >&2
  exit 1
fi

# --- Version ----------------------------------------------------------------

CURRENT="$(node deploy/set-version.mjs --current)"
echo "    current version: $CURRENT"

if [[ -n "$EXPLICIT_VERSION" ]]; then
  if [[ ! "$EXPLICIT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Not a semver version: $EXPLICIT_VERSION" >&2
    exit 2
  fi
  NEXT="$EXPLICIT_VERSION"
else
  # From the newest *tag*, not package.json — an aborted release that left the tree bumped
  # must not cause a version to be skipped. --print writes nothing.
  NEXT="$(node deploy/set-version.mjs --next "$LEVEL" --print)"
fi

TAG="v$NEXT"
echo "    next version:    $NEXT  (tag $TAG)"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists. Delete it or choose another version." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  warn "Dry run — would release $TAG and push to origin."
  exit 0
fi

# --- Checks -----------------------------------------------------------------

if [[ "$SKIP_CHECKS" == "0" ]]; then
  step 'Running checks (use --skip-checks to skip)'
  pnpm install --frozen-lockfile
  pnpm lint
  pnpm -r typecheck
  pnpm -r test

  if [[ -x "sidecar/.venv/bin/python" ]]; then
    sidecar/.venv/bin/python -m pytest sidecar -q
  elif [[ -x "sidecar/.venv/Scripts/python.exe" ]]; then
    sidecar/.venv/Scripts/python.exe -m pytest sidecar -q
  else
    warn 'Sidecar venv not found — skipping Python tests. CI will still run them.'
  fi
fi

# --- Bump, commit, tag, push ------------------------------------------------

step "Setting version $NEXT"
node deploy/set-version.mjs "$NEXT" >/dev/null

step 'Committing and tagging'
git add -A
git commit -m "release: $TAG"
# Annotated, not lightweight: records who cut the release and when, and `git describe`
# only considers annotated tags by default.
git tag -a "$TAG" -m "Impressive OCR $NEXT"

step 'Pushing'
git push origin main
git push origin "$TAG"

REMOTE="$(git remote get-url origin | sed -e 's/\.git$//' -e 's#^git@github\.com:#https://github.com/#')"
printf '\n\033[32mReleased %s.\033[0m\n' "$TAG"
echo "Watch the build:  $REMOTE/actions"
echo "Release will be:  $REMOTE/releases/tag/$TAG"
