// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref } from 'vue';
import { COUNTRY_CODES, type LicenseStatus, type LicenseTier } from '@impressive-ocr/shared';
import { licenseApi } from '../api/endpoints';

/**
 * Registering an installation, and activating the key that comes back.
 *
 * Kept out of the components because there are two of them — the first-run step and the
 * System page card — and both need the same four-state walk. Duplicating it would guarantee
 * they drift, and the state that would drift first is the one nobody expects: `awaiting-key`.
 *
 * The flow is not the obvious one, and the shape here exists to make that visible:
 *
 * - **Personal.** Register an email → the licence server sends a verification link → clicking
 *   it triggers a *second* email carrying the key → the key is entered here. Registering
 *   alone activates nothing, which is why there is a screen between the two.
 * - **Commercial.** The key came with the purchase, so only the last step applies.
 */

export type LicenseScreen = 'choose' | 'register' | 'awaiting-key' | 'activate' | 'done';

export function useLicense() {
  const status = ref<LicenseStatus | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);

  /** What the user picked before anything has been sent. Null until they choose. */
  const chosenTier = ref<LicenseTier | null>(null);
  /** Set when someone in `awaiting-key` says they have their key now. */
  const enteringKey = ref(false);

  const email = ref('');
  const country = ref('');
  const licenseKey = ref('');

  /**
   * Country names in the user's own language, from the platform rather than from a
   * translation file. `Intl.DisplayNames` is in every browser and Electron build we support;
   * the fallback is the bare code, which is still selectable and still correct.
   */
  function countryOptions(locale: string): { value: string; title: string }[] {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }

    return COUNTRY_CODES.map((code) => ({
      value: code,
      title: names?.of(code) ?? code,
    })).sort((a, b) => a.title.localeCompare(b.title, locale));
  }

  const screen = computed<LicenseScreen>(() => {
    const state = status.value?.state;
    if (state === 'active') return 'done';
    if (state === 'awaiting-key') return enteringKey.value ? 'activate' : 'awaiting-key';
    // `invalid` returns to the form rather than to the choice: the tier was right, the key or
    // the address was not, and sending someone back to "personal or commercial?" to correct a
    // typo would lose the rest of what they typed.
    if (state === 'invalid') return 'activate';
    return chosenTier.value === null ? 'choose' : chosenTier.value === 'personal' ? 'register' : 'activate';
  });

  /** Both forms need an address; only registration needs a country. */
  const canRegister = computed(() => isEmail(email.value) && country.value.length === 2);
  const canActivate = computed(() => isEmail(email.value) && licenseKey.value.trim().length >= 8);

  async function load(): Promise<void> {
    try {
      status.value = await licenseApi.get();
      // Prefilled so someone returning to finish activation does not retype the address the
      // key was sent to — and cannot accidentally use a different one, which would be refused.
      if (status.value.email !== null && email.value === '') {
        email.value = status.value.email;
      }
    } catch {
      // A failed read must not block the screen. Treated as unregistered, which asks.
      status.value = null;
    }
  }

  function choose(tier: LicenseTier): void {
    chosenTier.value = tier;
    error.value = null;
  }

  /** Back to the tier choice, discarding a half-filled form. */
  function reconsider(): void {
    chosenTier.value = null;
    enteringKey.value = false;
    error.value = null;
  }

  function enterKey(): void {
    enteringKey.value = true;
    error.value = null;
  }

  async function register(): Promise<void> {
    if (!canRegister.value) return;
    await run(async () => {
      status.value = await licenseApi.registerPersonal({
        email: email.value.trim(),
        country: country.value,
      });
    });
  }

  async function activate(): Promise<void> {
    if (!canActivate.value) return;
    // The tier a key belongs to: the stored one once registered, otherwise what was chosen.
    const tier = status.value?.tier ?? chosenTier.value ?? 'commercial';
    await run(async () => {
      status.value = await licenseApi.activate({
        tier,
        email: email.value.trim(),
        licenseKey: licenseKey.value.trim(),
      });
      if (status.value.state === 'invalid') {
        // The server accepted the request and refused the licence, so its own wording is the
        // explanation — there is nothing better this could say.
        error.value = status.value.message;
      }
    });
  }

  async function release(): Promise<void> {
    await run(async () => {
      status.value = await licenseApi.release();
      chosenTier.value = null;
      enteringKey.value = false;
      licenseKey.value = '';
    });
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await action();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy.value = false;
    }
  }

  return {
    status,
    screen,
    busy,
    error,
    email,
    country,
    licenseKey,
    chosenTier,
    canRegister,
    canActivate,
    countryOptions,
    load,
    choose,
    reconsider,
    enterKey,
    register,
    activate,
    release,
  };
}

/**
 * Enough of a check to enable a button.
 *
 * Deliberately not a full RFC 5322 pattern: the licence server validates properly and emails
 * the address, so the only job here is to stop someone submitting an obviously empty field.
 * A stricter regex here would reject valid addresses the server would have accepted.
 */
function isEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 5 && trimmed.includes('@') && !trimmed.endsWith('@');
}
