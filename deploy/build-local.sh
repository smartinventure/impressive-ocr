#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build Impressive OCR locally, publishing nothing.
#
# The counterpart to release.sh, which only bumps and tags and leaves every artifact to CI.
# This builds the artifacts here, on this machine, from the working tree as it stands — no
# git checks, no commit, no tag, no push, no registry. Nothing leaves the machine.
#
# Secrets come from `deploy/.env.local`, which is gitignored. Copy `.env.local.example` to
# it and fill in what you have. Without it the build still runs and produces unsigned
# artifacts that cannot reach the licence server, which is what you want for testing.
#
#   ./deploy/build-local.sh                  everything this host can build
#   ./deploy/build-local.sh desktop          just the desktop app
#   ./deploy/build-local.sh docker           just the container image
#   ./deploy/build-local.sh desktop docker
#   ./deploy/build-local.sh --list           show what this host can build, and build nothing
#   ./deploy/build-local.sh --checks         run lint/typecheck/tests first
#
# One deliberate limit: a desktop app can only be built for the operating system you are on.
# electron-builder needs the platform's own toolchain, and macOS signing and notarisation
# need macOS. To ship all three you need all three machines — which is the reason the tagged
# CI release exists and why this script is for testing, not for cutting a release.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }
good() { printf '\033[32m    %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

# --- Arguments --------------------------------------------------------------

WANT_DESKTOP=0
WANT_SERVER=0
WANT_DOCKER=0
EXPLICIT=0
RUN_CHECKS=0
LIST_ONLY=0
IMAGE_TAG=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    desktop) WANT_DESKTOP=1; EXPLICIT=1; shift ;;
    server)  WANT_SERVER=1;  EXPLICIT=1; shift ;;
    docker)  WANT_DOCKER=1;  EXPLICIT=1; shift ;;
    all)     EXPLICIT=0; shift ;;
    --checks) RUN_CHECKS=1; shift ;;
    --list)   LIST_ONLY=1; shift ;;
    --tag)    IMAGE_TAG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --- Secrets ----------------------------------------------------------------
#
# Sourced rather than parsed: the file is ours, it is gitignored, and `set -a` is the whole
# implementation. Values are never echoed — a build log is the classic place a key leaks.

ENV_FILE="$REPO_ROOT/deploy/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  step "Loading deploy/.env.local"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  good 'Loaded.'
else
  warn 'No deploy/.env.local — building unsigned, with no licence keys.'
  info 'Copy deploy/.env.local.example to deploy/.env.local to change that.'
fi

# Products have working defaults; only the keys are secret. Setting them here means a build
# without an env file still identifies itself correctly to the licence server.
export IMPRESSIVE_OCR_PRODUCT_COMMUNITY="${IMPRESSIVE_OCR_PRODUCT_COMMUNITY:-impressiveocrcommunity}"
export IMPRESSIVE_OCR_PRODUCT_COMMERCIAL="${IMPRESSIVE_OCR_PRODUCT_COMMERCIAL:-impressiveocrcommercial}"

# --- What this host can do --------------------------------------------------

case "$(uname -s)" in
  Darwin)            HOST_OS=mac ;;
  Linux)             HOST_OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS=win ;;
  *) echo "Unrecognised host: $(uname -s)" >&2; exit 1 ;;
esac

HOST_ARCH="$(node -p 'process.arch')"
VERSION="$(node deploy/set-version.mjs --current)"

HAS_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  HAS_DOCKER=1
fi

step "Impressive OCR $VERSION — host: $HOST_OS/$HOST_ARCH"

if [[ "$EXPLICIT" == "0" ]]; then
  WANT_DESKTOP=1
  WANT_SERVER=1
  WANT_DOCKER="$HAS_DOCKER"
fi

info "desktop  $( [[ $WANT_DESKTOP == 1 ]] && echo "yes  ($HOST_OS only — see the note in --help)" || echo 'no' )"
info "server   $( [[ $WANT_SERVER == 1 ]] && echo 'yes' || echo 'no' )"
if [[ "$WANT_DOCKER" == "1" && "$HAS_DOCKER" == "0" ]]; then
  info 'docker   requested, but Docker is not running'
else
  info "docker   $( [[ $WANT_DOCKER == 1 ]] && echo 'yes' || echo 'no — Docker not available' )"
fi

if [[ "$LIST_ONLY" == "1" ]]; then
  exit 0
fi

if [[ "$WANT_DOCKER" == "1" && "$HAS_DOCKER" == "0" ]]; then
  echo 'Docker was asked for but `docker info` failed. Start Docker Desktop, or drop the argument.' >&2
  exit 1
fi

if [[ "$WANT_DESKTOP" == "0" && "$WANT_SERVER" == "0" && "$WANT_DOCKER" == "0" ]]; then
  warn 'Nothing to build.'
  exit 0
fi

# --- Checks -----------------------------------------------------------------

if [[ "$RUN_CHECKS" == "1" ]]; then
  step 'Checks'
  pnpm lint
  pnpm -r typecheck
  pnpm -r test
fi

# --- Shared prerequisites ---------------------------------------------------

step 'Building the web UI'
pnpm --filter @impressive-ocr/web build

if [[ "$WANT_DESKTOP" == "1" || "$WANT_SERVER" == "1" ]]; then
  step "Fetching the bundled uv for $HOST_OS/$HOST_ARCH"
  if [[ "$WANT_DESKTOP" == "1" ]]; then
    if [[ "$HOST_OS" == "mac" ]]; then
      # Both, because electron-builder.yml builds arm64 and x64 from the one run and
      # `vendor/uv-<arch>` is resolved per build. Fetching only the host's leaves the other
      # app without a uv binary, and it fails at the runtime bootstrap rather than at build.
      node deploy/fetch-uv.mjs --target mac --arch arm64
      node deploy/fetch-uv.mjs --target mac --arch x64
    else
      node deploy/fetch-uv.mjs --target "$HOST_OS" --arch "$HOST_ARCH"
    fi
  fi
  if [[ "$WANT_SERVER" == "1" ]]; then
    node deploy/fetch-uv.mjs --target server --arch "$HOST_ARCH"
  fi
fi

# --- Desktop ----------------------------------------------------------------

if [[ "$WANT_DESKTOP" == "1" ]]; then
  step "Packaging the desktop app for $HOST_OS"

  # `--publish never` is already in the package script. It is the one flag that must never be
  # relaxed here: electron-builder will happily create a GitHub release from a laptop.
  case "$HOST_OS" in
    win)
      if [[ -n "${AZURE_CLIENT_ID:-}" && -n "${AZURE_SIGNING_ENDPOINT:-}" ]]; then
        good 'Azure Trusted Signing configured — signing.'
        pnpm --filter @impressive-ocr/desktop package --win \
          -c.win.azureSignOptions.endpoint="$AZURE_SIGNING_ENDPOINT" \
          -c.win.azureSignOptions.codeSigningAccountName="${AZURE_CODE_SIGNING_ACCOUNT:-}" \
          -c.win.azureSignOptions.certificateProfileName="${AZURE_CERT_PROFILE:-}" \
          -c.win.azureSignOptions.publisherName="${AZURE_PUBLISHER_NAME:-}"
      else
        warn 'No Azure signing configuration — the installer will be UNSIGNED (SmartScreen will warn).'
        pnpm --filter @impressive-ocr/desktop package --win
      fi
      ;;
    mac)
      if [[ -n "${CSC_LINK:-}" ]]; then
        good 'Certificate configured — signing, and notarising if the Apple credentials are set.'
        pnpm --filter @impressive-ocr/desktop package --mac
      else
        # Without this electron-builder reads an empty CSC_LINK as a certificate *path* and
        # resolves it to the project directory, then hunts the keychain for any identity.
        warn 'No CSC_LINK — producing an UNSIGNED macOS build.'
        CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @impressive-ocr/desktop package --mac
      fi
      ;;
    linux)
      pnpm --filter @impressive-ocr/desktop package --linux
      ;;
  esac
fi

# --- Headless server --------------------------------------------------------

if [[ "$WANT_SERVER" == "1" ]]; then
  step 'Packaging the headless server'
  if [[ "$HOST_OS" == "win" ]]; then
    warn 'Packaging on Windows cannot record the POSIX executable bit.'
    info 'The launcher inside the tarball will not be runnable. Build this one on Linux to ship it.'
  fi
  node deploy/package-server.mjs --arch "$HOST_ARCH"
fi

# --- Container image --------------------------------------------------------

if [[ "$WANT_DOCKER" == "1" ]]; then
  TAG="${IMAGE_TAG:-impressive-ocr:$VERSION-local}"
  step "Building the container image ($TAG)"

  # Built for local use only: loaded into the daemon, never pushed, and tagged `-local` so it
  # cannot be mistaken for the published ghcr.io image. Build args rather than runtime
  # environment, matching the released image, so the registration screen works on first run.
  docker build \
    -f deploy/docker/Dockerfile \
    --platform linux/amd64 \
    --build-arg "PRODUCT_COMMUNITY=$IMPRESSIVE_OCR_PRODUCT_COMMUNITY" \
    --build-arg "PRODUCT_COMMERCIAL=$IMPRESSIVE_OCR_PRODUCT_COMMERCIAL" \
    --build-arg "INSTALLER_KEY_COMMUNITY=${IMPRESSIVE_OCR_INSTALLER_KEY_COMMUNITY:-}" \
    --build-arg "INSTALLER_KEY_COMMERCIAL=${IMPRESSIVE_OCR_INSTALLER_KEY_COMMERCIAL:-}" \
    -t "$TAG" \
    .
  good "Image built: $TAG"
  info "Run it:  docker run -d -p 127.0.0.1:8084:8084 -v impressive-ocr-data:/data $TAG"
fi

# --- Done -------------------------------------------------------------------

printf '\n\033[32mBuilt %s locally. Nothing was pushed.\033[0m\n' "$VERSION"
if [[ -d dist/release ]]; then
  echo 'Artifacts in dist/release:'
  # Only the shippable files. electron-builder also leaves win-unpacked/, mac/ and
  # linux-unpacked/ there, which are gigabytes of intermediate output.
  find dist/release -maxdepth 1 -type f \
    \( -name '*.exe' -o -name '*.dmg' -o -name '*.zip' -o -name '*.AppImage' \
       -o -name '*.deb' -o -name '*.tar.gz' \) \
    -exec ls -lh {} \; | awk '{ printf "    %-10s %s\n", $5, $NF }'
fi
