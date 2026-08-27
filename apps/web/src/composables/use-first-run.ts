// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref } from 'vue';
import {
  CONSENT_TERMS_VERSION,
  type ConsentStatus,
  type LicenseStatus,
  type RuntimeStatus,
} from '@impressive-ocr/shared';
import { consentApi, licenseApi, systemApi } from '../api/endpoints';

/**
 * The two things a brand-new installation has to get through before it is usable: agreeing to
 * the terms, and installing the OCR engine.
 *
 * Both live here rather than in the dialog, so the component stays a template and this stays
 * testable without mounting anything.
 */

export type FirstRunStep = 'loading' | 'consent' | 'licence' | 'engine' | 'done';

export function useFirstRun() {
  const consent = ref<ConsentStatus | null>(null);
  const runtime = ref<RuntimeStatus | null>(null);
  const license = ref<LicenseStatus | null>(null);
  const accepting = ref(false);
  const error = ref<string | null>(null);
  /** Set when the user dismisses the engine prompt, which is advice rather than a gate. */
  const engineAcknowledged = ref(false);
  /**
   * Set when the licence step is passed or skipped.
   *
   * Skipping is always allowed. An unregistered installation runs under the AGPL, which every
   * recipient already holds — a licence screen that could not be passed would not be a
   * registration prompt, it would be a lock, and this product does not have one.
   */
  const licenceSettled = ref(false);

  const step = computed<FirstRunStep>(() => {
    if (consent.value === null) {
      return 'loading';
    }
    if (!consent.value.isCurrent) {
      return 'consent';
    }
    // Asked after the terms, because agreeing to them is what makes the registration honest:
    // the licence server records that both were accepted, and this is where they were.
    if (!licenceSettled.value && license.value?.state !== 'active') {
      return 'licence';
    }
    // Only worth saying on a machine that cannot actually OCR anything yet. On every later
    // start the engine is installed and this never appears.
    if (!engineAcknowledged.value && runtime.value?.state === 'not-installed') {
      return 'engine';
    }
    return 'done';
  });

  /** Whether the blocking dialog should be on screen at all. */
  const isOpen = computed(
    () => step.value === 'consent' || step.value === 'licence' || step.value === 'engine',
  );

  async function load(): Promise<void> {
    try {
      consent.value = await consentApi.get();
    } catch {
      // A failed read must not lock someone out of their own installation. Treat it as
      // already agreed: the alternative is an unusable app because one request went wrong.
      consent.value = {
        acceptedVersion: CONSENT_TERMS_VERSION,
        acceptedAt: null,
        requiredVersion: CONSENT_TERMS_VERSION,
        isCurrent: true,
      };
      // The licence step is settled too, and for the same reason. If the app cannot reach
      // its own backend, putting a registration form in front of the user simply moves the
      // lock-out one screen along — the form's first action would fail as well.
      licenceSettled.value = true;
      return;
    }

    // Always read, not only on a fresh install: someone who skipped registration should be
    // asked again next time, and someone who has registered should never see the step at all.
    license.value = await licenseApi.get().catch(() => null);
    if (license.value === null) {
      // Unreadable licence state must not hold up the app. Treated as settled: the worst
      // outcome is that nobody is asked, which costs a registration rather than an install.
      licenceSettled.value = true;
    }

    if (!consent.value.isCurrent) {
      // Fetched now rather than after accepting, so the later steps appear instantly.
      runtime.value = await systemApi.runtime().catch(() => null);
    }
  }

  async function accept(): Promise<void> {
    if (consent.value === null || accepting.value) {
      return;
    }
    accepting.value = true;
    error.value = null;
    try {
      consent.value = await consentApi.accept(consent.value.requiredVersion);
      // Re-read: an install may have finished while the terms were on screen.
      runtime.value = await systemApi.runtime().catch(() => runtime.value);
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      accepting.value = false;
    }
  }

  function acknowledgeEngine(): void {
    engineAcknowledged.value = true;
  }

  function settleLicence(): void {
    licenceSettled.value = true;
  }

  return {
    step,
    isOpen,
    consent,
    runtime,
    license,
    accepting,
    error,
    load,
    accept,
    acknowledgeEngine,
    settleLicence,
  };
}
