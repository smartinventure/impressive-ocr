// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The application version, in one place.
 *
 * Written by `deploy/release.ps1` / `deploy/release.sh` alongside every `package.json` and
 * `sidecar/pyproject.toml`, so a release cannot ship a UI reporting one version while the
 * updater compares against another.
 *
 * Do not edit by hand — run the release script.
 */
export const APP_VERSION = '1.0.6';
