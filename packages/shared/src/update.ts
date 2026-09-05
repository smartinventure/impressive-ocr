// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/**
 * Updating the **headless server**, which cannot update itself.
 *
 * The desktop app has electron-updater: it downloads a new build and restarts itself, and
 * none of this applies to it. A container is the opposite case. A process inside a container
 * cannot pull a new image and recreate the container it is running in — that is the host's
 * job, and giving the app the Docker socket to do it anyway would hand a document-processing
 * service root-equivalent control of the machine it runs on. We do not do that.
 *
 * So the work is split. The app *asks*; a small script on the host *acts*:
 *
 * ```
 *   inside the container                     on the host
 *   --------------------                     -----------
 *   GET  /api/update/check                   impressive-ocr-update.sh, installed by
 *     -> is there a newer image?             install-impressive-ocr.sh and triggered by
 *     -> is a host updater listening?        a systemd path unit or a cron poll
 *   POST /api/update/trigger                        |
 *     -> writes <controlDir>/update-request  -------+--> docker compose pull && up -d
 * ```
 *
 * Two files in a bind-mounted control directory are the whole interface, and the direction of
 * each matters:
 *
 * - `host-update-enabled` — written by the installer, read by the app. Its presence is the
 *   only thing that makes the one-click button appear. Without it the UI shows the command to
 *   copy instead, because a button that silently does nothing is worse than no button.
 * - `update-request` — written by the app, deleted by the host script. The host acts on its
 *   mere presence and never reads its contents, so nothing inside the container can influence
 *   what the host runs.
 *
 * That last point is the security property worth keeping: the host script takes no input. It
 * runs one fixed command. A compromised container can cause an image pull and nothing else.
 */

/** Where the container's control directory is mounted, inside the container. */
export const UPDATE_CONTROL_DIR = '/control';

/** Set by the installer to advertise that a host-side updater is watching. */
export const HOST_UPDATE_MARKER_FILE = 'host-update-enabled';

/** Written by the app to ask for one. Presence is the signal; contents are never read. */
export const UPDATE_REQUEST_FILE = 'update-request';

/**
 * The installer, at a stable raw URL on the public repository.
 *
 * Pinned to `main` rather than a tag on purpose: the link goes in a registration email that
 * outlives any one release, and an installer that always fetches the newest image is the
 * correct behaviour for a first install.
 */
export const INSTALLER_SCRIPT_URL =
  'https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh';

/** What a check against the release feed found. */
export const serverUpdateOutcomeSchema = z.discriminatedUnion('state', [
  /** Running the newest release, or a newer one than has been published. */
  z.object({ state: z.literal('current') }),
  z.object({
    state: z.literal('available'),
    latestVersion: z.string(),
    releaseNotesUrl: z.string().nullable(),
  }),
  /**
   * The feed could not be read: no network, GitHub down, or rate-limited.
   *
   * A state of its own rather than a `latestVersion` of null, so the UI can say "could not
   * check" instead of implying the installation is up to date when nothing was learned.
   */
  z.object({ state: z.literal('unreachable'), reason: z.string() }),
  /** Checking is switched off in Settings, so nothing was contacted. */
  z.object({ state: z.literal('disabled') }),
]);

export type ServerUpdateOutcome = z.infer<typeof serverUpdateOutcomeSchema>;

/**
 * Whether a host-side updater exists, and whether it has been asked to run.
 *
 * `unavailable` covers both "this is a desktop install" and "the container was started by
 * hand without the installer" — the UI treats them the same, because the answer in both cases
 * is the manual command.
 */
export const hostUpdateStateSchema = z.enum(['unavailable', 'ready', 'requested']);
export type HostUpdateState = z.infer<typeof hostUpdateStateSchema>;

export const serverUpdateStatusSchema = z.object({
  currentVersion: z.string(),
  outcome: serverUpdateOutcomeSchema,
  hostUpdate: hostUpdateStateSchema,
  /** The manual fallback, shown whenever `hostUpdate` is not `ready`. */
  updateCommand: z.string(),
  installerUrl: z.string(),
  /** ISO timestamp of the last successful read of the feed, for "checked 5 minutes ago". */
  checkedAt: z.string().nullable(),
});

export type ServerUpdateStatus = z.infer<typeof serverUpdateStatusSchema>;

export const serverUpdateTriggerResultSchema = z.object({
  /** `already-requested` when a request file is already waiting; asking twice is harmless. */
  state: z.enum(['scheduled', 'already-requested']),
});

export type ServerUpdateTriggerResult = z.infer<typeof serverUpdateTriggerResultSchema>;

/**
 * What to run by hand when no host updater is installed.
 *
 * A constant rather than a string built in the UI, so the command in the dialog, the command
 * in the docs and the command the installer writes cannot drift apart.
 */
export const MANUAL_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';
