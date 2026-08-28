// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  quickOptionsSchema,
  recommendedProfile,
  type QuickOptions,
  type QuickRun,
  type QuickRunFile,
} from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';
import { useLiveStore } from '../../../stores/live-store';
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

/**
 * Where the last run's settings are kept.
 *
 * `localStorage`, not session: the point is that someone who always wants Word does not
 * re-pick it every time they open the app, which means surviving the app being closed.
 * Settings only — never the files, never an output path from a machine this browser may not
 * be talking to any more.
 */
const SETTINGS_KEY = 'impressive-ocr.quick.settings';

interface RememberedSettings {
  options: QuickOptions;
  source: 'server' | 'upload';
  outputPath: string;
}

function rememberSettings(settings: RememberedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing, or storage full. Costs the convenience, not the run.
  }
}

/**
 * Read back what was stored, discarding anything the current schema no longer accepts.
 *
 * Parsed rather than trusted: this value outlives releases, so a build that removes a format
 * or renames a strategy would otherwise restore a setting the server rejects — and the user
 * would meet that as a failed run with no idea why.
 */
function recallSettings(): RememberedSettings | null {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored === null) return null;

    const parsed = JSON.parse(stored) as Partial<RememberedSettings>;
    const options = quickOptionsSchema.safeParse(parsed.options);
    if (!options.success) return null;

    return {
      options: options.data,
      source: parsed.source === 'server' ? 'server' : 'upload',
      outputPath: typeof parsed.outputPath === 'string' ? parsed.outputPath : '',
    };
  } catch {
    return null;
  }
}

/**
 * How far a run is, counted in pages rather than in whole documents.
 *
 * Documents alone made the commonest Quick Mode run -- a single file -- a bar that sat at
 * zero and indeterminate for the whole job and then jumped to full, which reads as a hang on
 * anything longer than a couple of pages. Both engines stream a page event as each page
 * lands, so the document in flight can contribute its own fraction of one slot.
 *
 * Exported for its own test: it is arithmetic with three ways to be wrong -- a bar that goes
 * backwards, one that passes 100%, and one that divides by a page count of zero.
 */
/**
 * Where a produced file sits, given the folder the server reported and the file's own name.
 *
 * Joined on the client so an upload run never has to disclose a server-side working directory
 * to a browser. The separator comes from the folder itself, which is the only reliable
 * indication of the platform the files are actually on: the same page runs in a browser that
 * may be nowhere near the machine that wrote them.
 *
 * A join that turns out to be wrong is not dangerous. The desktop app validates the path
 * before opening anything and reports it as missing, which is also what an expired result
 * looks like.
 */
export function joinOutputPath(folder: string, fileName: string): string {
  const separator = folder.includes('\\') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${fileName}`;
}

export function progressFraction(input: {
  finished: number;
  total: number;
  pagesDone: number;
  /** Null until the sidecar has opened the document and counted its pages. */
  pageCount: number | null;
}): number {
  if (input.total <= 0) return 0;

  // Worth at most one slot however many pages it has, so the bar is monotonic: page 5 of 5
  // leaves it exactly where finishing the document does.
  const partial =
    input.pageCount !== null && input.pageCount > 0
      ? Math.min(input.pagesDone / input.pageCount, 1)
      : 0;

  return Math.min((input.finished + partial) / input.total, 1);
}

export function useQuickRun() {
  const remembered = recallSettings();

  // Upload by default: someone opening this in a browser is usually not sitting at the
  // server. The desktop app overrides it below, where both are the same machine anyway.
  const source = ref<'server' | 'upload'>(remembered?.source ?? 'upload');
  const serverFiles = ref<string[]>([]);
  const uploadFiles = ref<File[]>([]);
  const outputPath = ref(remembered?.outputPath ?? '');
  const options = ref<QuickOptions>(remembered?.options ?? quickOptionsSchema.parse({}));

  // The live stream carries per-job events; polling carries the run's shape. Both are needed:
  // the poll never sees a message the sidecar emitted between two ticks.
  const store = useLiveStore();
  const desktop = useDesktopBridge();
  if (desktop.isDesktop.value) {
    // The native dialog returns real paths, so the desktop never uploads to itself.
    source.value = 'server';
  }

  /**
   * Preselect the better profile once the machine's capabilities are known.
   *
   * Applied by watcher rather than at construction because the hardware probe arrives over
   * the wire, usually after this composable is created. Guarded on the user not having
   * touched the control: a preference stated before the probe landed outranks ours.
   */
  // A remembered profile is a decision the user already made, so the recommendation must
  // not quietly undo it on the next visit.
  const profileChosen = ref(remembered !== null);
  watch(
    () => store.system?.hardware.availableProfiles,
    (profiles) => {
      if (profiles === undefined || profileChosen.value) return;
      options.value = { ...options.value, profile: recommendedProfile(profiles) };
    },
    { immediate: true },
  );

  /** Called by the view when the profile select is used, to stop the watcher overriding it. */
  function keepProfile(): void {
    profileChosen.value = true;
  }

  const run = ref<QuickRun | null>(null);
  const progress = ref<QuickRunProgress | null>(null);
  const uploadFraction = ref(0);
  const busy = ref(false);
  const error = ref<string | null>(null);

  /**
   * What pressing Start is doing right now.
   *
   * `busy` alone could not be shown honestly: it covers sending bytes, which has a real
   * percentage, and waiting for the server to create the run, which has none. Reported as one
   * state the screen showed a bar that filled and then sat at 100% for as long as the server
   * took, which reads as a hang -- and on the desktop, where there is no upload at all, it
   * showed nothing whatsoever between the click and the run appearing.
   */
  const phase = ref<'idle' | 'uploading' | 'starting'>('idle');

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

  /**
   * The sidecar's own latest line for whatever is running.
   *
   * Model loading is most of the wall clock on the first document — forty seconds on a warm
   * GPU box — and none of it moves the page counter, because the pages have not started yet.
   * Without this the card says "0 of 1" and nothing else for the whole of it.
   */
  const statusMessage = computed(() => {
    const running = (progress.value?.jobs ?? []).find((job) => job.state === 'running');
    if (running === undefined) return null;
    return store.latestJobEvent[running.id]?.message ?? null;
  });

  /**
   * Warnings and errors from the run's jobs.
   *
   * A format that could not be written does *not* fail the job — the Markdown and JSON that
   * succeeded are still worth having — so without surfacing these, asking for Word and
   * receiving no Word looks exactly like success.
   */
  const problems = computed(() => {
    const jobs = progress.value?.jobs ?? [];
    return jobs.flatMap((job) => store.jobProblems[job.id] ?? []);
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

  const completedFraction = computed(() =>
    progressFraction({
      finished: succeeded.value + failed.value,
      total: run.value?.fileCount ?? 0,
      pagesDone: currentDocument.value?.pagesDone ?? 0,
      pageCount: currentDocument.value?.pageCount ?? null,
    }),
  );

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

  /**
   * The individual results, offered alongside the ZIP.
   *
   * Fetched once the run is finished rather than polled: the list cannot change afterwards,
   * and asking for it on every progress tick would be a request per second for a value that
   * is constant.
   */
  const files = ref<QuickRunFile[]>([]);

  async function loadFiles(): Promise<void> {
    // Two reasons to want this list, and they are not the same reason. An upload run needs
    // download links, because the results exist only on the server. A folder run wrote
    // straight into the user's own directory, where offering downloads would only invite
    // second copies — but the desktop app can offer to *open* what is already there, and
    // needs the names to do it.
    if (run.value === null) return;
    if (!canDownload.value && run.value.outputPath === null) return;
    try {
      files.value = await quickApi.files(run.value.pipelineId);
    } catch {
      // The ZIP button is unaffected, so a failure here costs a convenience rather than the
      // results themselves. Nothing worth interrupting the user for.
      files.value = [];
    }
  }

  /** A file's own URL, for a direct link per row. */
  function fileUrl(file: QuickRunFile): string {
    return run.value === null ? '' : quickApi.fileUrl(run.value.pipelineId, file.index);
  }

  /**
   * Where a produced file sits on disk, or null when there is no such place.
   *
   * Null for uploads on purpose: those live in a working directory that is swept on a
   * retention window, and is the server's business rather than the user's — on a headless
   * install it is not even the same machine.
   *
   * Joined here rather than sent by the server, so an upload run never has to disclose a
   * server-side path to a browser. The separator is taken from the folder the server gave
   * us, which is the only reliable indication of the platform the files are actually on.
   * A join that turns out to be wrong is not dangerous: the desktop app validates the path
   * and reports it as missing.
   */
  function filePath(file: QuickRunFile): string | null {
    const folder = run.value?.outputPath ?? null;
    return folder === null ? null : joinOutputPath(folder, file.fileName);
  }

  async function start(): Promise<void> {
    if (!canStart.value) return;

    busy.value = true;
    error.value = null;
    try {
      if (source.value === 'upload') {
        uploadFraction.value = 0;
        phase.value = 'uploading';
        const { uploadId } = await quickApi.upload([...uploadFiles.value], (fraction) => {
          uploadFraction.value = fraction;
        });
        phase.value = 'starting';
        run.value = await quickApi.start({ source: 'upload', uploadId, options: options.value });
      } else {
        phase.value = 'starting';
        run.value = await quickApi.start({
          source: 'server',
          files: [...serverFiles.value],
          outputPath: outputPath.value.trim(),
          options: options.value,
        });
      }
      rememberRun(run.value);
      // Stored only once a run has actually been accepted, so a setting that the server
      // refused is never the one waiting for the user next time.
      rememberSettings({
        options: options.value,
        source: source.value,
        outputPath: outputPath.value,
      });
      startPolling();
    } catch (caught) {
      error.value = caught instanceof ApiRequestError ? caught.message : 'Could not start the run.';
    } finally {
      busy.value = false;
      phase.value = 'idle';
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
    files.value = [];
    rememberRun(null);
    run.value = null;
    progress.value = null;
    uploadFraction.value = 0;
    phase.value = 'idle';
    error.value = null;
    stopPolling();
  }

  async function refresh(): Promise<void> {
    if (run.value === null) return;
    try {
      progress.value = await quickApi.progress(run.value.pipelineId);
      if (!isRunning.value) {
        stopPolling();
        // The results are fixed the moment the run stops, so this is the one moment worth
        // asking for them.
        void loadFiles();
      }
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
    phase,
    busy,
    error,
    fileCount,
    canStart,
    isRunning,
    isFinished,
    succeeded,
    failed,
    failureMessage,
    statusMessage,
    problems,
    device,
    pageProgress,
    currentDocument,
    completedFraction,
    keepProfile,
    canDownload,
    downloadUrl,
    absoluteDownloadUrl,
    files,
    fileUrl,
    filePath,
    loadFiles,
    start,
    cancel,
    reset,
  };
}
