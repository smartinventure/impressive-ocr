// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { APP_VERSION, type HostUpdateState } from '@impressive-ocr/shared';
import { createLogger } from '../../infra/logger';
import type { HostUpdateBridge } from './host-update-bridge';
import type { LatestRelease, ReleaseClient } from './release-client';
import { RELEASE_CACHE_MS, ServerUpdateService } from './server-update-service';

const logger = createLogger({ level: 'silent', pretty: false });

/** A version guaranteed to be newer than whatever the release script last wrote. */
function newerThanCurrent(): string {
  const [major = 0] = APP_VERSION.split('.').map(Number);
  return `${major + 1}.0.0`;
}

function releaseClient(release: LatestRelease | null): ReleaseClient {
  return { latestRelease: vi.fn().mockResolvedValue(release) };
}

function failingClient(message = 'network down'): ReleaseClient {
  return { latestRelease: vi.fn().mockRejectedValue(new Error(message)) };
}

function hostBridge(state: HostUpdateState, requestSucceeds = true): HostUpdateBridge {
  return {
    state: vi.fn().mockReturnValue(state),
    requestUpdate: vi.fn().mockReturnValue(requestSucceeds),
  } as unknown as HostUpdateBridge;
}

interface ServiceOverrides {
  releases?: ReleaseClient;
  host?: HostUpdateBridge;
  isCheckEnabled?: () => boolean;
  now?: () => number;
}

function service(overrides: ServiceOverrides = {}): ServerUpdateService {
  return new ServerUpdateService({
    releases: overrides.releases ?? releaseClient(null),
    host: overrides.host ?? hostBridge('unavailable'),
    isCheckEnabled: overrides.isCheckEnabled ?? (() => true),
    logger,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

const signal = new AbortController().signal;

describe('ServerUpdateService', () => {
  describe('status', () => {
    it('offers a newer release', async () => {
      const latestVersion = newerThanCurrent();
      const result = await service({
        releases: releaseClient({ version: latestVersion, releaseNotesUrl: 'https://x/rel' }),
      }).status(signal);

      expect(result.outcome).toEqual({
        state: 'available',
        latestVersion,
        releaseNotesUrl: 'https://x/rel',
      });
      expect(result.currentVersion).toBe(APP_VERSION);
    });

    it('strips the leading v from the tag', async () => {
      // The tags are written `v1.2.3` but APP_VERSION carries none, and a dialog reading
      // "1.0.6 -> v2.0.0" looks like a bug in the release rather than in the label.
      const result = await service({
        releases: releaseClient({ version: `v${newerThanCurrent()}`, releaseNotesUrl: null }),
      }).status(signal);

      expect(result.outcome).toEqual({
        state: 'available',
        latestVersion: newerThanCurrent(),
        releaseNotesUrl: null,
      });
    });

    it('reports current when the published release is the one running', async () => {
      const result = await service({
        releases: releaseClient({ version: APP_VERSION, releaseNotesUrl: null }),
      }).status(signal);

      expect(result.outcome).toEqual({ state: 'current' });
    });

    it('reports unreachable rather than current when the feed cannot be read', async () => {
      // The distinction that matters: an air-gapped installation must not be told it is up
      // to date on the strength of a request that never completed.
      const result = await service({ releases: failingClient() }).status(signal);

      expect(result.outcome).toEqual({ state: 'unreachable', reason: 'network down' });
      expect(result.checkedAt).toBeNull();
    });

    it('contacts nothing when update checking is switched off', async () => {
      const releases = releaseClient({ version: newerThanCurrent(), releaseNotesUrl: null });
      const result = await service({ releases, isCheckEnabled: () => false }).status(signal);

      expect(result.outcome).toEqual({ state: 'disabled' });
      expect(releases.latestRelease).not.toHaveBeenCalled();
    });

    it('reports the host update state alongside the release', async () => {
      const result = await service({ host: hostBridge('ready') }).status(signal);
      expect(result.hostUpdate).toBe('ready');
    });

    it('always carries the manual command and the installer URL', async () => {
      // Both are shown whenever there is no host updater, so neither may be conditional.
      const result = await service().status(signal);
      expect(result.updateCommand).toContain('docker compose pull');
      expect(result.installerUrl).toMatch(/^https:\/\//);
    });
  });

  describe('caching', () => {
    it('reuses a successful answer instead of asking again', async () => {
      // Unauthenticated GitHub allows 60 requests an hour per address; a handful of open
      // tabs would exhaust that for one answer that changes at most daily.
      const releases = releaseClient({ version: APP_VERSION, releaseNotesUrl: null });
      const subject = service({ releases });

      await subject.status(signal);
      await subject.status(signal);
      await subject.status(signal);

      expect(releases.latestRelease).toHaveBeenCalledTimes(1);
    });

    it('asks again once the cached answer has expired', async () => {
      const releases = releaseClient({ version: APP_VERSION, releaseNotesUrl: null });
      let clock = 1_000;
      const subject = service({ releases, now: () => clock });

      await subject.status(signal);
      clock += RELEASE_CACHE_MS + 1;
      await subject.status(signal);

      expect(releases.latestRelease).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failure', async () => {
      // A check that failed because the network was down must succeed as soon as it is back,
      // not six hours later.
      const releases = failingClient();
      const subject = service({ releases });

      await subject.status(signal);
      await subject.status(signal);

      expect(releases.latestRelease).toHaveBeenCalledTimes(2);
    });

    it('shares one request between concurrent callers', async () => {
      // The dashboard and the System page opening together are one answer, not two.
      const releases = releaseClient({ version: APP_VERSION, releaseNotesUrl: null });
      const subject = service({ releases });

      await Promise.all([subject.status(signal), subject.status(signal), subject.status(signal)]);

      expect(releases.latestRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('requestUpdate', () => {
    it('schedules an update when a host updater is listening', () => {
      const host = hostBridge('ready');
      expect(service({ host }).requestUpdate()).toEqual({ state: 'scheduled' });
      expect(host.requestUpdate).toHaveBeenCalled();
    });

    it('refuses when no host updater is installed', () => {
      // Mapped to a 409 by the route. Reporting a scheduled update that nothing will perform
      // is the one outcome worth ruling out.
      const host = hostBridge('unavailable');
      expect(service({ host }).requestUpdate()).toBeNull();
      expect(host.requestUpdate).not.toHaveBeenCalled();
    });

    it('is idempotent while a request is already waiting', () => {
      const host = hostBridge('requested');
      expect(service({ host }).requestUpdate()).toEqual({ state: 'already-requested' });
      expect(host.requestUpdate).not.toHaveBeenCalled();
    });

    it('refuses when the request file could not be written', () => {
      // A bind mount the container cannot write to: the UI must say so rather than claim an
      // update is on its way.
      expect(service({ host: hostBridge('ready', false) }).requestUpdate()).toBeNull();
    });
  });
});
