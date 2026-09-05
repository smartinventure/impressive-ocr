// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, ref } from 'vue';
import type { ServerUpdateStatus } from '@impressive-ocr/shared';
import { updateApi } from '../api/endpoints';
import { useDesktopBridge } from './use-desktop-bridge';

/**
 * Whether the **headless server** has an update, and the request that applies it.
 *
 * The counterpart to `use-app-update`, which covers the desktop app and does nothing in a
 * browser. Kept apart rather than folded into it because the two share no mechanism: the
 * desktop path talks to the Electron main process over IPC and can install an update itself,
 * and this one talks to the server over HTTP and can only ask a script on the host to do it.
 * A single composable would be a union of two states with almost no overlap.
 *
 * Module scope, for the reason the licence status is: two components read this, and a `ref`
 * per caller would give each its own copy and its own request.
 */

const status = ref<ServerUpdateStatus | null>(null);
const checking = ref(false);
const triggering = ref(false);

/** Set when the trigger call fails, so the dialog can fall back to the manual command. */
const triggerFailed = ref(false);

let loaded = false;

export function useServerUpdate() {
  const desktop = useDesktopBridge();

  /** There is a newer release, and this is a build where that is worth saying. */
  const updateAvailable = computed(
    () => !desktop.isDesktop.value && status.value?.outcome.state === 'available',
  );

  const latestVersion = computed(() =>
    status.value?.outcome.state === 'available' ? status.value.outcome.latestVersion : null,
  );

  const releaseNotesUrl = computed(() =>
    status.value?.outcome.state === 'available' ? status.value.outcome.releaseNotesUrl : null,
  );

  /**
   * The host can apply it with one click.
   *
   * False on a container started by hand and on any installation whose control directory is
   * not writable — both cases show the command to copy instead. A button that silently does
   * nothing is worse than no button.
   */
  const canApplyFromHere = computed(
    () => status.value?.hostUpdate === 'ready' && !triggerFailed.value,
  );

  /** An update has been asked for and the host has not collected it yet. */
  const pending = computed(() => status.value?.hostUpdate === 'requested');

  async function check(force = false): Promise<void> {
    // Never from the desktop shell: it has electron-updater, and asking the server as well
    // would offer a container update to someone running an installer.
    if (desktop.isDesktop.value) return;
    if (loaded && !force) return;

    checking.value = true;
    try {
      status.value = await updateApi.check();
      loaded = true;
    } catch {
      // A failed check is not worth surfacing. The server already distinguishes "could not
      // reach the feed" from "up to date" in the payload; this is the case where the server
      // itself could not be reached, and the rest of the UI is already saying so.
      status.value = null;
    } finally {
      checking.value = false;
    }
  }

  /**
   * Ask the host to pull the new image and recreate the container.
   *
   * The container goes away while that happens, so this request is expected to be the last
   * one this page makes — the reply may never arrive. A failure is therefore not treated as
   * proof that nothing happened: it flips to the manual command only when the server answered
   * and refused, which is the 409 case.
   */
  async function applyUpdate(): Promise<void> {
    triggering.value = true;
    try {
      await updateApi.trigger();
      // Reflect the request immediately rather than waiting for the next poll: the container
      // is about to stop, and a check issued now would very likely fail.
      if (status.value !== null) status.value = { ...status.value, hostUpdate: 'requested' };
    } catch {
      triggerFailed.value = true;
    } finally {
      triggering.value = false;
    }
  }

  return {
    status,
    checking,
    triggering,
    updateAvailable,
    latestVersion,
    releaseNotesUrl,
    canApplyFromHere,
    pending,
    check,
    applyUpdate,
  };
}
