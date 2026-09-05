// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  APP_VERSION,
  INSTALLER_SCRIPT_URL,
  MANUAL_UPDATE_COMMAND,
  type ServerUpdateOutcome,
  type ServerUpdateStatus,
  type ServerUpdateTriggerResult,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import type { HostUpdateBridge } from './host-update-bridge';
import type { ReleaseClient } from './release-client';
import { isNewerVersion } from './version-order';

/**
 * Whether a newer release exists, and the request that asks the host to install it.
 *
 * Only the headless server uses this. The desktop app has electron-updater, which downloads
 * and restarts itself; nothing here runs in that build.
 */

export interface ServerUpdateServiceOptions {
  releases: ReleaseClient;
  host: HostUpdateBridge;
  /**
   * `autoUpdateEnabled` from settings, read fresh on every call.
   *
   * Checking is an outbound request to api.github.com, which reveals this installation's IP
   * address to GitHub. That is the only network call the product makes that the user did not
   * initiate, so it honours the same switch the desktop updater does. Off means nothing is
   * contacted at all — not a check whose result is hidden.
   */
  isCheckEnabled: () => boolean;
  logger: Logger;
  /** Injected so the cache can be tested without waiting six hours. */
  now?: () => number;
}

/**
 * How long a successful answer is reused.
 *
 * Unauthenticated GitHub allows 60 requests an hour per address. Every page load asking would
 * exhaust that on a machine with a handful of browser tabs open, and the answer to "is there
 * a new release" does not change minute to minute. Failures are not cached: a check that
 * failed because the network was down should succeed as soon as it is back.
 */
export const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;

interface CachedOutcome {
  outcome: ServerUpdateOutcome;
  checkedAt: number;
}

export class ServerUpdateService {
  private cache: CachedOutcome | null = null;
  private readonly now: () => number;

  /**
   * The in-flight check, so concurrent callers share one request.
   *
   * Without this, a dashboard and a System page opening together produce two requests against
   * a 60-per-hour budget for one answer.
   */
  private inFlight: Promise<ServerUpdateOutcome> | null = null;

  constructor(private readonly options: ServerUpdateServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async status(signal: AbortSignal): Promise<ServerUpdateStatus> {
    const outcome = await this.checkOutcome(signal);
    return {
      currentVersion: APP_VERSION,
      outcome,
      hostUpdate: this.options.host.state(),
      updateCommand: MANUAL_UPDATE_COMMAND,
      installerUrl: INSTALLER_SCRIPT_URL,
      checkedAt: this.cache === null ? null : new Date(this.cache.checkedAt).toISOString(),
    };
  }

  /**
   * Ask the host to pull the new image and recreate the container.
   *
   * Null when no host updater is listening. The caller maps that to a 409: reporting a
   * scheduled update that nothing will ever perform is the one outcome worth ruling out.
   */
  requestUpdate(): ServerUpdateTriggerResult | null {
    const state = this.options.host.state();
    if (state === 'unavailable') return null;
    if (state === 'requested') return { state: 'already-requested' };
    return this.options.host.requestUpdate() ? { state: 'scheduled' } : null;
  }

  private async checkOutcome(signal: AbortSignal): Promise<ServerUpdateOutcome> {
    if (!this.options.isCheckEnabled()) return { state: 'disabled' };

    if (this.cache !== null && this.now() - this.cache.checkedAt < RELEASE_CACHE_MS) {
      return this.cache.outcome;
    }
    // Share one request between concurrent callers rather than starting a second.
    this.inFlight ??= this.fetchOutcome(signal).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOutcome(signal: AbortSignal): Promise<ServerUpdateOutcome> {
    try {
      const release = await this.options.releases.latestRelease(signal);
      const outcome: ServerUpdateOutcome =
        release !== null && isNewerVersion(release.version, APP_VERSION)
          ? {
              state: 'available',
              // Normalised without the tag's leading `v`, so the UI never renders "vv1.1.0"
              // against a version string that carries none.
              latestVersion: release.version.replace(/^v/, ''),
              releaseNotesUrl: release.releaseNotesUrl,
            }
          : { state: 'current' };

      this.cache = { outcome, checkedAt: this.now() };
      return outcome;
    } catch (error) {
      // Deliberately not cached, and deliberately not an error-level log. Being unable to
      // reach GitHub is the normal state of an air-gapped installation, which is a supported
      // way to run this product rather than a fault.
      this.options.logger.debug({ err: error }, 'Update check could not reach the release feed');
      return {
        state: 'unreachable',
        reason: error instanceof Error ? error.message : 'The release feed could not be read',
      };
    }
  }
}
