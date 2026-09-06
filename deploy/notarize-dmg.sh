#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Notarise and staple macOS disk images.
#
#   ./deploy/notarize-dmg.sh dist/release/*.dmg
#
# electron-builder notarises the .app and staples the ticket to it, which is what lets the
# application launch without contacting Apple. It does not do the same for the disk image the
# app ships in, and Apple's guidance is to sign from the inside out, notarise the outermost
# container, and staple the outermost item that supports stapling. This is that last part.
#
# Why it matters: without a ticket of its own, opening the downloaded .dmg makes Gatekeeper
# ask Apple's servers whether the image is known. That is slower than reading a stapled
# ticket, and on a machine that is offline or behind a restrictive network it can warn about
# the installer before the user ever reaches the app inside it.
#
# The image must already be signed -- `dmg.sign: true` in electron-builder.yml. An unsigned
# disk image can be submitted, but the notary service leaves it out of the ticket because its
# cdhash is unstable, so there is nothing to staple and `stapler staple` fails with
# "Record not found". That failure reads as a notarisation problem and is a signing one.
#
# Credentials come from the environment, whichever set is present:
#   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER   (App Store Connect key, preferred)
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#
# Written for bash 3.2, which is what macOS ships.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "notarize-dmg.sh only runs on macOS." >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <dmg> [dmg...]" >&2
  exit 2
fi

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }

# --- Credentials ------------------------------------------------------------
#
# The API key is preferred and checked first, which is the opposite of the order
# electron-builder uses internally. Here it is safe to prefer it: this script picks one set
# and passes only that to notarytool, so a half-configured Apple ID cannot shadow a working
# key the way it does inside electron-builder.

AUTH=()
if [[ -n "${APPLE_API_KEY:-}" ]]; then
  if [[ -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
    echo 'APPLE_API_KEY is set but APPLE_API_KEY_ID or APPLE_API_ISSUER is missing.' >&2
    exit 1
  fi
  AUTH=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  info 'Notarising disk images with the App Store Connect API key.'
elif [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo 'APPLE_APP_SPECIFIC_PASSWORD is set but APPLE_ID or APPLE_TEAM_ID is missing.' >&2
    exit 1
  fi
  AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  info 'Notarising disk images with an Apple ID.'
else
  echo 'No notarisation credentials. Set APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.' >&2
  exit 1
fi

# --- Notarise ---------------------------------------------------------------

for dmg in "$@"; do
  [[ -f "$dmg" ]] || { echo "Not a file: $dmg" >&2; exit 1; }
  step "Notarising $(basename "$dmg")"

  # Checked before submitting, because an unsigned image is accepted and then cannot be
  # stapled -- a twenty-minute round trip to reach a misleading error.
  if ! codesign --verify --verbose=2 "$dmg" >/dev/null 2>&1; then
    echo "::error::$dmg is not signed, so it cannot be stapled. Set dmg.sign: true in electron-builder.yml." >&2
    exit 1
  fi

  # --wait blocks until Apple reaches a verdict. --timeout keeps a stuck submission from
  # sitting until the job's own limit kills it with no diagnosis.
  submit_log=$(mktemp)
  if ! xcrun notarytool submit "$dmg" "${AUTH[@]}" --wait --timeout 45m 2>&1 | tee "$submit_log"; then
    id=$(sed -n 's/^ *id: *\([0-9a-f-]*\).*/\1/p' "$submit_log" | head -1)
    if [[ -n "$id" ]]; then
      # Apple's own reason for rejecting it. Far more useful than "status: Invalid", and the
      # first thing anyone would otherwise have to be told to go and fetch by hand.
      echo '--- notarisation log from Apple ---' >&2
      xcrun notarytool log "$id" "${AUTH[@]}" >&2 || true
    fi
    rm -f "$submit_log"
    exit 1
  fi
  rm -f "$submit_log"

  step "Stapling $(basename "$dmg")"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  info 'Stapled.'
done

printf '\n\033[32mAll disk images are notarised and stapled.\033[0m\n'
