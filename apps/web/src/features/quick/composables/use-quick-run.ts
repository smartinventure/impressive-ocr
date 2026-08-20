// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, ref } from 'vue';
import { quickOptionsSchema, type QuickOptions, type QuickRun } from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
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

export function useQuickRun() {
  const source = ref<'server' | 'upload'>('server');
  const serverFiles = ref<string[]>([]);
  const uploadFiles = ref<File[]>([]);
  const outputPath = ref('');
  const options = ref<QuickOptions>(quickOptionsSchema.parse({}));

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
  const failed = computed(() => progress.value?.stats.failed ?? 0);

  const completedFraction = computed(() => {
    const total = run.value?.fileCount ?? 0;
    if (total === 0) return 0;
    return (succeeded.value + failed.value) / total;
  });

  /** Uploads are downloaded; server runs wrote to a folder the user can already open. */
  const canDownload = computed(
    () => run.value?.source === 'upload' && isFinished.value && succeeded.value > 0,
  );

  const downloadUrl = computed(() =>
    run.value === null ? '' : quickApi.downloadUrl(run.value.pipelineId),
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

  /** Clear the screen for another run, discarding anything uploaded for the last one. */
  async function reset(): Promise<void> {
    const finished = run.value;
    run.value = null;
    progress.value = null;
    uploadFraction.value = 0;
    error.value = null;
    stopPolling();

    if (finished !== null && finished.source === 'upload') {
      // The results have been downloaded or abandoned; either way there is no reason to leave
      // the user's documents on the server until the retention sweep.
      try {
        await quickApi.discard(finished.pipelineId, finished.id);
      } catch {
        // The sweeper will get it.
      }
    }
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
    completedFraction,
    canDownload,
    downloadUrl,
    start,
    cancel,
    reset,
  };
}
