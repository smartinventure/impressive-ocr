// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_TERMS_VERSION } from '@impressive-ocr/shared';
import { consentApi, licenseApi, systemApi } from '../api/endpoints';
import { useFirstRun } from './use-first-run';

/**
 * The first-run gate decides whether someone can use the application at all, so its two
 * failure directions are not symmetrical: showing the terms once too often is a nuisance,
 * while locking a working installation behind a failed request is not survivable.
 */

vi.mock('../api/endpoints', () => ({
  consentApi: { get: vi.fn(), accept: vi.fn() },
  systemApi: { runtime: vi.fn() },
  licenseApi: { get: vi.fn() },
}));

const consentGet = vi.mocked(consentApi.get);
const consentAccept = vi.mocked(consentApi.accept);
const runtime = vi.mocked(systemApi.runtime);
const licenceGet = vi.mocked(licenseApi.get);

/**
 * An already-registered installation, which is what most of these tests want: the licence
 * step is not what they are about, and leaving it unregistered would put it between consent
 * and the engine prompt in every one of them.
 */
function licenceStatus(state: 'unregistered' | 'active') {
  return { state, tier: null, email: null } as unknown as Awaited<
    ReturnType<typeof licenseApi.get>
  >;
}

function status(accepted: boolean) {
  return {
    acceptedVersion: accepted ? CONSENT_TERMS_VERSION : 0,
    acceptedAt: accepted ? '2026-08-25T00:00:00.000Z' : null,
    requiredVersion: CONSENT_TERMS_VERSION,
    isCurrent: accepted,
  };
}

function runtimeStatus(state: 'not-installed' | 'ready') {
  return { state, currentStep: null, progressPercent: 0 } as unknown as Awaited<
    ReturnType<typeof systemApi.runtime>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  licenceGet.mockResolvedValue(licenceStatus('active'));
});

describe('useFirstRun', () => {
  it('asks for consent on a fresh installation', async () => {
    consentGet.mockResolvedValue(status(false));
    runtime.mockResolvedValue(runtimeStatus('ready'));

    const first = useFirstRun();
    await first.load();

    expect(first.step.value).toBe('consent');
    expect(first.isOpen.value).toBe(true);
  });

  it('stays out of the way once the terms have been agreed', async () => {
    consentGet.mockResolvedValue(status(true));

    const first = useFirstRun();
    await first.load();

    expect(first.step.value).toBe('done');
    expect(first.isOpen.value).toBe(false);
    // Nothing to say about the engine, so nothing was asked about it.
    expect(runtime).not.toHaveBeenCalled();
  });

  it('points at the System page when the engine is missing', async () => {
    consentGet.mockResolvedValue(status(false));
    runtime.mockResolvedValue(runtimeStatus('not-installed'));
    consentAccept.mockResolvedValue(status(true));

    const first = useFirstRun();
    await first.load();
    await first.accept();

    expect(first.step.value).toBe('engine');
  });

  it('finishes straight away when the engine is already installed', async () => {
    consentGet.mockResolvedValue(status(false));
    runtime.mockResolvedValue(runtimeStatus('ready'));
    consentAccept.mockResolvedValue(status(true));

    const first = useFirstRun();
    await first.load();
    await first.accept();

    expect(first.step.value).toBe('done');
  });

  it('lets the engine prompt be dismissed', async () => {
    consentGet.mockResolvedValue(status(false));
    runtime.mockResolvedValue(runtimeStatus('not-installed'));
    consentAccept.mockResolvedValue(status(true));

    const first = useFirstRun();
    await first.load();
    await first.accept();
    first.acknowledgeEngine();

    expect(first.step.value).toBe('done');
  });

  it('does not lock the application out when the consent check fails', async () => {
    // A backend hiccup must not be indistinguishable from "you may not use this".
    consentGet.mockRejectedValue(new Error('network'));

    const first = useFirstRun();
    await first.load();

    expect(first.isOpen.value).toBe(false);
  });

  it('keeps the terms on screen when recording the agreement fails', async () => {
    consentGet.mockResolvedValue(status(false));
    runtime.mockResolvedValue(runtimeStatus('ready'));
    consentAccept.mockRejectedValue(new Error('These terms have been superseded.'));

    const first = useFirstRun();
    await first.load();
    await first.accept();

    expect(first.step.value).toBe('consent');
    expect(first.error.value).toContain('superseded');
  });
});

/**
 * The licence step sits between the terms and the engine prompt.
 *
 * It must never become a gate. An unregistered installation is running under the AGPL, which
 * every recipient already holds — a screen that could not be passed would be a lock, and this
 * product does not have one.
 */
describe('useFirstRun and the licence step', () => {
  it('asks about the licence once the terms are agreed', async () => {
    consentGet.mockResolvedValue(status(true));
    licenceGet.mockResolvedValue(licenceStatus('unregistered'));

    const firstRun = useFirstRun();
    await firstRun.load();

    expect(firstRun.step.value).toBe('licence');
  });

  it('never asks an installation that is already registered', async () => {
    consentGet.mockResolvedValue(status(true));
    licenceGet.mockResolvedValue(licenceStatus('active'));

    const firstRun = useFirstRun();
    await firstRun.load();

    expect(firstRun.step.value).not.toBe('licence');
  });

  it('can always be skipped', async () => {
    consentGet.mockResolvedValue(status(true));
    licenceGet.mockResolvedValue(licenceStatus('unregistered'));

    const firstRun = useFirstRun();
    await firstRun.load();
    firstRun.settleLicence();

    expect(firstRun.step.value).not.toBe('licence');
  });

  it('does not block when the licence state cannot be read', async () => {
    // The same rule as the consent check above: a request that failed must not cost someone
    // the use of their own installation.
    consentGet.mockResolvedValue(status(true));
    licenceGet.mockRejectedValue(new Error('offline'));

    const firstRun = useFirstRun();
    await firstRun.load();

    expect(firstRun.step.value).not.toBe('licence');
    expect(firstRun.isOpen.value).toBe(false);
  });

  it('does not block when the backend is unreachable entirely', async () => {
    // The regression: a failed consent read returned early before the licence was loaded,
    // which left the licence step showing — moving the lock-out one screen along rather than
    // avoiding it.
    consentGet.mockRejectedValue(new Error('offline'));

    const firstRun = useFirstRun();
    await firstRun.load();

    expect(firstRun.isOpen.value).toBe(false);
  });
});
