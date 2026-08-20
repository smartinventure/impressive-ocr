// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AuthStatus } from '@impressive-ocr/shared';
import { authApi } from '../api/endpoints';
import { setCsrfToken } from '../api/client';

/**
 * Whether this browser may talk to the API, and how.
 *
 * Loaded once before the first route resolves, so the router can decide between the app and
 * the login screen without a flash of protected content.
 */
export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus | null>(null);
  const checked = ref(false);

  /**
   * Whether the login screen should be shown.
   *
   * Enabled *and* a password actually set: with the flag on but no password the backend does
   * not enforce anything, so demanding a password nobody has configured would lock the owner
   * out of their own instance.
   */
  const mustSignIn = computed(
    () =>
      status.value !== null &&
      status.value.authEnabled &&
      status.value.passwordSet &&
      !status.value.authenticated,
  );

  const isProtected = computed(
    () => status.value?.authEnabled === true && status.value.passwordSet,
  );

  const passwordSet = computed(() => status.value?.passwordSet === true);

  function apply(next: AuthStatus): void {
    status.value = next;
    // Refilled on every check, which is what lets a page reload keep using a session whose
    // cookie survived while the in-memory token did not.
    setCsrfToken(next.csrfToken ?? null);
  }

  async function check(): Promise<AuthStatus | null> {
    try {
      apply(await authApi.status());
    } catch {
      // The API being unreachable is a connectivity problem, not an authorisation one; the
      // live store surfaces it. Leaving status null keeps the app rendering rather than
      // bouncing to a login screen that also cannot load.
      status.value = null;
    }
    checked.value = true;
    return status.value;
  }

  async function signIn(password: string): Promise<void> {
    const { csrfToken } = await authApi.login(password);
    setCsrfToken(csrfToken);
    await check();
  }

  async function signOut(): Promise<void> {
    try {
      await authApi.logout();
    } finally {
      // Even if the call fails, this browser should stop believing it is signed in.
      setCsrfToken(null);
      await check();
    }
  }

  /** Called by the API client on any 401, from wherever it happened. */
  function onSessionLost(): void {
    if (status.value !== null) {
      status.value = { ...status.value, authenticated: false };
    }
    setCsrfToken(null);
  }

  return {
    status,
    checked,
    mustSignIn,
    isProtected,
    passwordSet,
    check,
    signIn,
    signOut,
    onSessionLost,
  };
});
