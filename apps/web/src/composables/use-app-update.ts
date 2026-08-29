// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, readonly, ref } from 'vue';
import { useDesktopBridge, type UpdateStatus } from './use-desktop-bridge';

/**
 * Whether a newer release of the application exists, shared by everything that asks.
 *
 * Module scope on purpose, for the same reason the licence status is: two components read
 * this — the card on the System page and the notice on the dashboard — and a `ref` per caller
 * would give each its own copy, its own subscription to the main process, and its own check.
 * The licence status was written that way and the result was a banner insisting the
 * installation was unregistered beside a page showing it as active.
 *
 * Renders as "no update" in a browser and never asks. The headless server is updated by
 * whatever installed it, and there is no bridge to ask in the first place.
 */

const status = ref<UpdateStatus>({
  state: 'idle',
  version: null,
  progressPercent: 0,
  releaseNotesUrl: null,
  message: null,
});

const currentVersion = ref<string | null>(null);
const busy = ref(false);

/** One subscription for the process, however many components are mounted. */
let unsubscribe: (() => void) | null = null;
let subscribers = 0;

export function useAppUpdate() {
  const desktop = useDesktopBridge();

  /**
   * There is a release to act on.
   *
   * `downloading` is deliberately included: something is happening that the user started or
   * that started for them, and a notice that vanishes mid-download reads as a failure.
   */
  const updateAvailable = computed(
    () =>
      status.value.state === 'available' ||
      status.value.state === 'downloading' ||
      status.value.state === 'ready',
  );

  /** Subscribe to the main process, once, however many components call this. */
  function watch(): void {
    if (!desktop.isDesktop.value) return;
    subscribers += 1;
    if (unsubscribe !== null) return;

    // Subscribed before any check, so a download already running when a page opens shows its
    // real progress rather than starting from "idle".
    unsubscribe = desktop.onUpdateStatus((next) => {
      status.value = next;
    });
    void desktop.getVersion().then((version) => {
      currentVersion.value = version;
    });
  }

  /** Release one component's interest; the subscription ends when the last one goes. */
  function unwatch(): void {
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers > 0) return;
    unsubscribe?.();
    unsubscribe = null;
  }

  async function check(): Promise<void> {
    busy.value = true;
    try {
      const result = await desktop.checkForUpdate();
      if (result !== null) status.value = result;
    } finally {
      busy.value = false;
    }
  }

  async function download(): Promise<void> {
    busy.value = true;
    try {
      await desktop.downloadUpdate();
    } finally {
      busy.value = false;
    }
  }

  /**
   * Restarts the app. Deliberately explicit rather than something that happens on quit: a
   * pipeline may be mid-document, and the user picks the moment.
   */
  async function install(): Promise<void> {
    await desktop.installUpdate();
  }

  return {
    status: readonly(status),
    currentVersion: readonly(currentVersion),
    busy: readonly(busy),
    updateAvailable,
    isDesktop: desktop.isDesktop,
    watch,
    unwatch,
    check,
    download,
    install,
  };
}
