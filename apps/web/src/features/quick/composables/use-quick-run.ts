// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { quickOptionsSchema, type QuickOptions, type QuickRun } from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';
import { quickApi, type QuickRunProgress } from '../../../api/endpoints';

/**
 * Drives one Quick Mode run: upload or select, start, watch, cancel, download.
 *
 * All of the view's logic lives here so the SFC stays a template. Progress is polled rather
 * than taken from the SSE stream: a Quick run is short and self-contained, and the live store
 * deliberately carries only what the rest of the app shares.
 */

/** Often enough to feel live, rarely enough not to matter next to OCR itself. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Where the in-flight run is remembered across navigation.
 *
 * `sessionStorage`, not a Pinia store: it also has to survive a page reload, which is what
 * someone does when a long run looks stuck. Session rather than local, so it does not outlive
 * the tab and resurrect a run whose results have long since been swept.
 */
const ACTIVE_RUN_KEY = 'impressive-ocr.quick.active-run';

function rememberRun(run: QuickRun | null): void {
  try {
    if (run === null) sessionStorage.removeItem(ACTIVE_RUN_KEY);
    else sessionStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify(run));
  } catch {
    // Private browsing, or storage full. Losing the handle costs the progress view, not the
    // run itself, which continues on the server regardless.
  }
}

function recallRun(): QuickRun | null {
  try {
    const stored = sessionStorage.getItem(ACTIVE_RUN_KEY);
    return stored === null ? null : (JSON.parse(stored) as QuickRun);
  } catch {
    return null;
  }
}

export function useQuickRun() {
  // Upload by default: someone opening this in a browser is usually not sitting at the
  // server. The desktop app overrides it below, where both are the same machine anyway.
  const source = ref<'server' | 'upload'>('upload');
  const serverFiles = ref<string[]>([]);
  const uploadFiles = ref<File[]>([]);
  const outputPath = ref('');
  const options = ref<QuickOptions>(quickOptionsSchema.parse({}));

  const desktop = useDesktopBridge();
  if (desktop.isDesktop.value) {
    // The native dialog returns real paths, so the desktop never uploads to itself.
    source.value = 'server';
  }

  const run = ref<QuickRun | null>(null);
  const progress = ref<QuickRunProgress | null>(null);
  const uploadFraction = ref(0);
  const busy = ref(false);
  const error = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | undefined;

  const fileCount = computed(() =>
    source.value === 'server' ? serverFiles.value.length : uploadFiles.value.length,
  );

  const canStart = computed(() => {
    if (busy.value || run.value !== null || fileCount.value === 0) return false;
    // Uploads always come back as a download; only a server-side run needs somewhere to put
    // its results.
    return source.value === 'upload' || outputPath.value.trim().length > 0;
  });

  const isRunning = computed(
    () =>
      run.value !== null &&
      (progress.value?.stats.queued ?? 0) + (progress.value?.stats.running ?? 0) > 0,
  );

  const isFinished = computed(
    () => run.value !== null && !isRunning.value && progress.value !== null,
  );

  const succeeded = computed(() => progress.value?.stats.succeeded ?? 0);

  /**
   * Anything that ended without producing output.
   *
   * `quarantined` is a distinct terminal state -- a job that exhausted its retries -- and
   * counting only `failed` left the screen reporting "Finished, 0 succeeded, 0 failed" while
   * silently having lost the document.
   */
  const failed = computed(
    () => (progress.value?.stats.failed ?? 0) + (progress.value?.stats.quarantined ?? 0),
  );

  /** The most recent error, so a failed run says why rather than just showing a zero. */
  const failureMessage = computed(() => {
    const broken = (progress.value?.jobs ?? []).find(
      (job) => job.errorMessage !== null && job.errorMessage !== undefined,
    );
    return broken?.errorMessage ?? null;
  });

  /** Which device actually ran the work, reported by the job rather than assumed. */
  const device = computed(
    () => (progress.value?.jobs ?? []).find((job) => job.deviceUsed)?.deviceUsed ?? null,
  );

  /**
   * Page-level progress across the run.
   *
   * The sidecar reports pages as it finishes them, so a single 200-page scan shows movement
   * instead of one bar that sits at zero for twenty minutes and then jumps to done.
   */
  const pageProgress = computed(() => {
    const jobs = progress.value?.jobs ?? [];
    const done = jobs.reduce((total, job) => total + (job.pagesDone ?? 0), 0);
    const known = jobs.reduce((total, job) => total + (job.pageCount ?? 0), 0);
    return { done, total: known };
  });

  /** The document being worked on right now, if any. */
  const currentDocument = computed(() => {
    const running = (progress.value?.jobs ?? []).find((job) => job.state === 'running');
    if (running === undefined) return null;
    return {
      name: running.fileName,
      pagesDone: running.pagesDone ?? 0,
      pageCount: running.pageCount ?? null,
    };
  });

  const completedFraction = computed(() => {
    const total = run.value?.fileCount ?? 0;
    if (total === 0) return 0;
    return (succeeded.value + failed.value) / total;
  });

  /**
   * Uploads are downloaded; server runs wrote to a folder the user can already open.
   *
   * Requires at least one success, because a ZIP of nothing is worse than no button.
   */
  const canDownload = computed(
    () => run.value?.source === 'upload' && isFinished.value && succeeded.value > 0,
  );

  const downloadUrl = computed(() =>
    run.value === null ? '' : quickApi.downloadUrl(run.value.pipelineId),
  );

  /** Fully qualified, so it can be copied somewhere and used from another tab or machine. */
  const absoluteDownloadUrl = computed(() =>
    downloadUrl.value === '' ? '' : new URL(downloadUrl.value, window.location.origin).toString(),
  );

  async function start(): Promise<void> {
    if (!canStart.value) return;

    busy.value = true;
    error.value = null;
    try {
      if (source.value === 'upload') {
        uploadFraction.value = 0;
        const { uploadId } = await quickApi.upload([...uploadFiles.value], (fraction) => {
          uploadFraction.value = fraction;
        });
        run.value = await quickApi.start({ source: 'upload', uploadId, options: options.value });
      } else {
        run.value = await quickApi.start({
          source: 'server',
          files: [...serverFiles.value],
          outputPath: outputPath.value.trim(),
          options: options.value,
        });
      }
      rememberRun(run.value);
      startPolling();
    } catch (caught) {
      error.value = caught instanceof ApiRequestError ? caught.message : 'Could not start the run.';
    } finally {
      busy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    if (run.value === null) return;

    busy.value = true;
    try {
      await quickApi.cancel(run.value.pipelineId);
      await refresh();
    } catch (caught) {
      error.value =
        caught instanceof ApiRequestError ? caught.message : 'Could not cancel the run.';
    } finally {
      busy.value = false;
    }
  }

  /**
   * Clear the screen for another run.
   *
   * Deliberately does *not* delete the finished run. Its download link stays valid until the
   * retention sweep, so "start another" does not silently destroy results the user meant to
   * fetch later -- which is exactly what a copyable link is for. Uploaded *inputs* are already
   * gone; only the results remain, and they expire on their own.
   */
  function reset(): void {
    rememberRun(null);
    run.value = null;
    progress.value = null;
    uploadFraction.value = 0;
    error.value = null;
    stopPolling();
  }

  async function refresh(): Promise<void> {
    if (run.value === null) return;
    try {
      progress.value = await quickApi.progress(run.value.pipelineId);
      if (!isRunning.value) stopPolling();
    } catch {
      // A transient failure mid-run is not worth tearing the screen down for; the next tick
      // will either succeed or the user will cancel.
    }
  }

  function startPolling(): void {
    stopPolling();
    void refresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  /**
   * Pick a run back up when the screen is reopened.
   *
   * Navigating to the dashboard and back used to lose the progress view entirely -- the run
   * carried on, and the only way to see it was the Jobs page.
   */
  onMounted(() => {
    const previous = recallRun();
    if (previous !== null && run.value === null) {
      run.value = previous;
      startPolling();
    }
  });

  onBeforeUnmount(stopPolling);

  return {
    source,
    serverFiles,
    uploadFiles,
    outputPath,
    options,
    run,
    progress,
    uploadFraction,
    busy,
    error,
    fileCount,
    canStart,
    isRunning,
    isFinished,
    succeeded,
    failed,
    failureMessage,
    device,
    pageProgress,
    currentDocument,
    completedFraction,
    canDownload,
    downloadUrl,
    absoluteDownloadUrl,
    start,
    cancel,
    reset,
  };
}
