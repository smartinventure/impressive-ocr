// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref } from 'vue';
import { CONSENT_TERMS_VERSION, type ConsentStatus, type RuntimeStatus } from '@impressive-ocr/shared';
import { consentApi, systemApi } from '../api/endpoints';

/**
 * The two things a brand-new installation has to get through before it is usable: agreeing to
 * the terms, and installing the OCR engine.
 *
 * Both live here rather than in the dialog, so the component stays a template and this stays
 * testable without mounting anything.
 */

export type FirstRunStep = 'loading' | 'consent' | 'engine' | 'done';

export function useFirstRun() {
  const consent = ref<ConsentStatus | null>(null);
  const runtime = ref<RuntimeStatus | null>(null);
  const accepting = ref(false);
  const error = ref<string | null>(null);
  /** Set when the user dismisses the engine prompt, which is advice rather than a gate. */
  const engineAcknowledged = ref(false);

  const step = computed<FirstRunStep>(() => {
    if (consent.value === null) {
      return 'loading';
    }
    if (!consent.value.isCurrent) {
      return 'consent';
    }
    // Only worth saying on a machine that cannot actually OCR anything yet. On every later
    // start the engine is installed and this never appears.
    if (!engineAcknowledged.value && runtime.value?.state === 'not-installed') {
      return 'engine';
    }
    return 'done';
  });

  /** Whether the blocking dialog should be on screen at all. */
  const isOpen = computed(() => step.value === 'consent' || step.value === 'engine');

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
      return;
    }

    if (!consent.value.isCurrent) {
      // Fetched now rather than after accepting, so the second step appears instantly.
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

  return {
    step,
    isOpen,
    consent,
    runtime,
    accepting,
    error,
    load,
    accept,
    acknowledgeEngine,
  };
}
