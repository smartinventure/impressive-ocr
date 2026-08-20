// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  AppSettings,
  Job,
  PipelineWithStatus,
  RuntimeStatus,
  SystemStatus,
} from '@impressive-ocr/shared';
import { jobsApi, pipelinesApi, settingsApi, systemApi } from '../api/endpoints';
import {
  connectEventStream,
  type ConnectionState,
  type EventStreamHandle,
} from '../api/event-stream';

/**
 * The single subscriber to the event stream, and the source of truth for live state.
 *
 * One connection for the whole app, not one per view: each `EventSource` is a held-open HTTP
 * connection, and a handful of open screens would exhaust the browser's per-origin limit and
 * silently stall the last one.
 *
 * REST loads state; events only patch it. On reconnect the store refetches, because anything
 * published while the stream was down was never delivered.
 */
export const useLiveStore = defineStore('live', () => {
  const pipelines = ref<PipelineWithStatus[]>([]);
  const jobs = ref<Job[]>([]);
  const system = ref<SystemStatus | null>(null);
  const runtime = ref<RuntimeStatus | null>(null);
  const settings = ref<AppSettings | null>(null);
  const connection = ref<ConnectionState>('connecting');
  const loading = ref(true);
  const loadError = ref<string | null>(null);

  // shallowRef: the handle is an opaque object with no reactive interior, and deep-tracking
  // an EventSource would be pointless work on every event.
  const stream = shallowRef<EventStreamHandle | null>(null);

  const runtimeReady = computed(() => runtime.value?.state === 'ready');
  const globallyPaused = computed(() => system.value?.globallyPaused ?? false);

  const runningJobs = computed(() => jobs.value.filter((job) => job.state === 'running'));

  function pipelineById(id: string): PipelineWithStatus | undefined {
    return pipelines.value.find((pipeline) => pipeline.id === id);
  }

  function jobsForPipeline(pipelineId: string): Job[] {
    return jobs.value.filter((job) => job.pipelineId === pipelineId);
  }

  async function refresh(): Promise<void> {
    try {
      const [pipelineList, jobPage, status, appSettings] = await Promise.all([
        pipelinesApi.list(),
        jobsApi.list({ limit: 100 }),
        systemApi.status(),
        settingsApi.get(),
      ]);
      pipelines.value = pipelineList;
      jobs.value = jobPage.items;
      system.value = status;
      runtime.value = status.runtime;
      settings.value = appSettings;
      loadError.value = null;
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Could not load state';
    } finally {
      loading.value = false;
    }
  }

  function start(): void {
    if (stream.value !== null) {
      return;
    }
    void refresh();

    stream.value = connectEventStream({
      onStateChange: (state) => {
        connection.value = state;
      },
      onResync: () => {
        void refresh();
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'pipeline.upserted':
            upsertPipeline(event.pipeline);
            break;

          case 'pipeline.deleted':
            pipelines.value = pipelines.value.filter((item) => item.id !== event.pipelineId);
            break;

          case 'pipeline.status': {
            const pipeline = pipelineById(event.pipelineId);
            if (pipeline !== undefined) {
              // Patch in place rather than replacing the array, so a row being watched in a
              // table does not lose focus or selection on every tick.
              pipeline.status = event.status;
              pipeline.statusReason = event.statusReason;
              pipeline.stats = event.stats;
            }
            break;
          }

          case 'job.upserted':
            upsertJob(event.job);
            break;

          case 'job.progress': {
            const job = jobs.value.find((item) => item.id === event.jobId);
            if (job !== undefined) {
              job.pagesDone = event.pagesDone;
              job.pageCount = event.pageCount;
            }
            break;
          }

          case 'runtime.status':
            runtime.value = event.runtime;
            if (system.value !== null) {
              system.value.runtime = event.runtime;
            }
            break;

          case 'system.status':
            system.value = event.system;
            runtime.value = event.system.runtime;
            break;

          case 'job.event':
          case 'heartbeat':
            // Job timelines are loaded on demand by the detail drawer; the heartbeat only
            // exists to keep the connection open.
            break;
        }
      },
    });
  }

  function stop(): void {
    stream.value?.close();
    stream.value = null;
  }

  function upsertPipeline(pipeline: PipelineWithStatus): void {
    const index = pipelines.value.findIndex((item) => item.id === pipeline.id);
    if (index === -1) {
      pipelines.value = [...pipelines.value, pipeline].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      pipelines.value[index] = pipeline;
    }
  }

  function upsertJob(job: Job): void {
    const index = jobs.value.findIndex((item) => item.id === job.id);
    if (index === -1) {
      // Newest first, matching the jobs table's order.
      jobs.value = [job, ...jobs.value].slice(0, 500);
    } else {
      jobs.value[index] = job;
    }
  }

  /**
   * Whether any folder has been authorized.
   *
   * The allowlist is the app's security boundary and starts empty, so until the user adds a
   * folder there is nowhere a pipeline could legally read from or write to. The server
   * already refuses to create one; this lets the UI say so before the user fills in a long
   * form and loses it to a validation error.
   */
  const hasAuthorizedFolder = computed(() => (settings.value?.folderAllowlist.length ?? 0) > 0);

  return {
    pipelines,
    jobs,
    system,
    runtime,
    settings,
    hasAuthorizedFolder,
    connection,
    loading,
    loadError,
    runtimeReady,
    globallyPaused,
    runningJobs,
    pipelineById,
    jobsForPipeline,
    refresh,
    start,
    stop,
  };
});
