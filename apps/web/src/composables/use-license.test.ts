// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicenseStatus } from '@impressive-ocr/shared';
import { useLicense } from './use-license';

/**
 * The walk through registering and activating.
 *
 * The state worth pinning is `awaiting-key`. The licence server sends a verification link and
 * then a *second* email carrying the key, so there is a screen between "registered" and
 * "active" that a naive flow would skip — leaving someone looking at a finished-looking form
 * with no licence.
 */

// `vi.hoisted`, because `vi.mock` is lifted above every other statement in the file — a plain
// const would not exist yet when the factory runs.
const licenseApi = vi.hoisted(() => ({
  get: vi.fn(),
  registerPersonal: vi.fn(),
  activate: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({ licenseApi }));

function status(overrides: Partial<LicenseStatus> = {}): LicenseStatus {
  return {
    state: 'unregistered',
    tier: null,
    email: null,
    maskedKey: null,
    activatedAt: null,
    licenseExpires: null,
    updatesUntil: null,
    updateAccessExpired: false,
    seatsUsed: null,
    seatsAllowed: null,
    message: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  licenseApi.get.mockResolvedValue(status());
});

describe('useLicense', () => {
  it('starts by asking which licence applies', async () => {
    const licence = useLicense();
    await licence.load();

    expect(licence.screen.value).toBe('choose');
  });

  it('goes straight to a key form for a commercial licence', async () => {
    // A commercial customer already has a key from the purchase; there is nothing to register.
    const licence = useLicense();
    await licence.load();
    licence.choose('commercial');

    expect(licence.screen.value).toBe('activate');
  });

  it('stops at awaiting-key after registering, rather than looking finished', async () => {
    licenseApi.registerPersonal.mockResolvedValue(
      status({ state: 'awaiting-key', tier: 'personal', email: 'me@example.com' }),
    );

    const licence = useLicense();
    await licence.load();
    licence.choose('personal');
    licence.email.value = 'me@example.com';
    licence.country.value = 'DE';
    await licence.register();

    expect(licence.screen.value).toBe('awaiting-key');
  });

  it('requires a country before it will register', async () => {
    // The licence server rejects a registration without one, despite documenting it as
    // optional. Blocking the button is better than a round trip that fails.
    const licence = useLicense();
    await licence.load();
    licence.email.value = 'me@example.com';

    expect(licence.canRegister.value).toBe(false);
    licence.country.value = 'DE';
    expect(licence.canRegister.value).toBe(true);
  });

  it('sends the country with the registration', async () => {
    licenseApi.registerPersonal.mockResolvedValue(status({ state: 'awaiting-key' }));

    const licence = useLicense();
    await licence.load();
    licence.email.value = '  me@example.com  ';
    licence.country.value = 'DE';
    await licence.register();

    expect(licenseApi.registerPersonal).toHaveBeenCalledWith({
      email: 'me@example.com',
      country: 'DE',
    });
  });

  it('moves to the key form when the user says they have one', async () => {
    licenseApi.get.mockResolvedValue(status({ state: 'awaiting-key', email: 'me@example.com' }));

    const licence = useLicense();
    await licence.load();
    expect(licence.screen.value).toBe('awaiting-key');

    licence.enterKey();
    expect(licence.screen.value).toBe('activate');
  });

  it('prefills the address the key was sent to', async () => {
    // Activating with a different address is refused, so retyping it is a way to fail.
    licenseApi.get.mockResolvedValue(status({ state: 'awaiting-key', email: 'me@example.com' }));

    const licence = useLicense();
    await licence.load();

    expect(licence.email.value).toBe('me@example.com');
  });

  it('activates with the tier the licence belongs to', async () => {
    licenseApi.get.mockResolvedValue(
      status({ state: 'awaiting-key', tier: 'personal', email: 'me@example.com' }),
    );
    licenseApi.activate.mockResolvedValue(status({ state: 'active', tier: 'personal' }));

    const licence = useLicense();
    await licence.load();
    licence.licenseKey.value = 'IMC-1234-ABCD';
    await licence.activate();

    expect(licenseApi.activate).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'personal', licenseKey: 'IMC-1234-ABCD' }),
    );
    expect(licence.screen.value).toBe('done');
  });

  it('keeps a refused key on the form, with the reason the server gave', async () => {
    // Sending someone back to "personal or commercial?" to fix a typo would lose everything
    // else they typed.
    licenseApi.activate.mockResolvedValue(
      status({ state: 'invalid', message: 'That email address and licence key do not match.' }),
    );

    const licence = useLicense();
    await licence.load();
    licence.choose('commercial');
    licence.email.value = 'me@example.com';
    licence.licenseKey.value = 'IMP-0000-0000';
    await licence.activate();

    expect(licence.screen.value).toBe('activate');
    expect(licence.error.value).toContain('do not match');
  });

  it('reports a failure without leaving the screen stuck busy', async () => {
    licenseApi.activate.mockRejectedValue(new Error('The licence server could not be reached.'));

    const licence = useLicense();
    await licence.load();
    licence.choose('commercial');
    licence.email.value = 'me@example.com';
    licence.licenseKey.value = 'IMP-1234-ABCD';
    await licence.activate();

    expect(licence.error.value).toContain('could not be reached');
    expect(licence.busy.value).toBe(false);
  });

  it('returns to unregistered after releasing the seat', async () => {
    licenseApi.get.mockResolvedValue(status({ state: 'active', tier: 'personal' }));
    licenseApi.release.mockResolvedValue(status());

    const licence = useLicense();
    await licence.load();
    expect(licence.screen.value).toBe('done');

    await licence.release();
    expect(licence.screen.value).toBe('choose');
  });

  it('offers countries by name in the current language', () => {
    const licence = useLicense();
    const german = licence.countryOptions('de');

    expect(german.find((option) => option.value === 'DE')?.title).toBe('Deutschland');
    expect(licence.countryOptions('en').find((o) => o.value === 'DE')?.title).toBe('Germany');
  });

  it('sorts countries by their translated name, not by code', () => {
    // Sorting by code puts Egypt before Germany in a German list, which is not where anyone
    // would look for it.
    const licence = useLicense();
    const titles = licence.countryOptions('en').map((option) => option.title);

    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('survives an unreadable licence state rather than blocking the screen', async () => {
    licenseApi.get.mockRejectedValue(new Error('offline'));

    const licence = useLicense();
    await licence.load();

    expect(licence.screen.value).toBe('choose');
  });
});
