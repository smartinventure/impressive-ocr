<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { FINISHED_JOB_STATES } from '@impressive-ocr/shared';
import type { Job, JobEvent, JobListItem, JobState } from '@impressive-ocr/shared';
import { jobsApi, quickApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import StatusChip from '../../../components/status-chip.vue';
import JobDetailDrawer from '../components/job-detail-drawer.vue';
import type { StatusKey } from '../../../plugins/theme';

/** Jobs across all pipelines, with a detail drawer carrying the page-by-page timeline. */

const store = useLiveStore();
const { t } = useI18n();

const stateFilter = ref<JobState | null>(null);
const search = ref('');
const selected = ref<Job | null>(null);
const timeline = ref<JobEvent[]>([]);

const STATE_TO_CHIP: Record<JobState, StatusKey> = {
  discovered: 'queued',
  pending: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  quarantined: 'quarantined',
  cancelled: 'paused',
};

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return store.jobs.filter((job) => {
    if (stateFilter.value !== null && job.state !== stateFilter.value) {
      return false;
    }
    return needle.length === 0 || job.fileName.toLowerCase().includes(needle);
  });
});

/**
 * Quick runs are backed by a throwaway pipeline named after the moment it was created, which
 * is meaningless in a list. They get the mode's own name instead.
 */
function pipelineLabel(job: JobListItem): string {
  return job.pipelineKind === 'quick' ? t('nav.quick') : job.pipelineName;
}

/**
 * Whether this job's results can still be fetched.
 *
 * Only Quick runs: a watched pipeline already wrote its output to a folder the user chose and
 * can open. Results survive 24 hours, which is what makes offering this worthwhile rather
 * than a button that usually 404s.
 */
function canDownload(job: JobListItem): boolean {
  return job.pipelineKind === 'quick' && job.state === 'succeeded';
}

function downloadUrl(job: JobListItem): string {
  return quickApi.downloadUrl(job.pipelineId);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function progress(job: Job): string {
  if (job.pageCount === null) return '—';
  return `${job.pagesDone} ${t('common.of')} ${job.pageCount}`;
}

async function openJob(job: Job): Promise<void> {
  selected.value = job;
  timeline.value = await jobsApi.events(job.id);
}

async function retry(job: Job): Promise<void> {
  await jobsApi.retry(job.id);
  await store.refresh();
  selected.value = null;
}

/**
 * Clearing the history.
 *
 * History only: queued and running jobs stay, and the server refuses to be asked otherwise.
 * Nothing on disk is touched -- the documents and their results outlive their rows, and the
 * hashes that stop a watched pipeline re-reading a file it has already done are kept, so
 * clearing the list does not quietly re-queue a folder.
 *
 * The count comes from the server when the dialog opens rather than from the rows on screen,
 * which are capped and paged: counting those would print a number that is wrong exactly when
 * it matters, on the long history somebody actually wants to clear.
 */
const confirmingClear = ref(false);
const clearing = ref(false);
const clearable = ref<number | null>(null);
const clearError = ref<string | null>(null);
const clearedCount = ref<number | null>(null);

/** Clearing follows the state filter, so the failures can go without the successes. */
const clearScope = computed(() =>
  stateFilter.value !== null &&
  (FINISHED_JOB_STATES as readonly JobState[]).includes(stateFilter.value)
    ? stateFilter.value
    : undefined,
);

async function openClear(): Promise<void> {
  confirmingClear.value = true;
  clearable.value = null;
  clearError.value = null;
  clearedCount.value = null;
  try {
    clearable.value = (await jobsApi.clearable(clearScope.value)).clearable;
  } catch (error) {
    clearError.value = error instanceof Error ? error.message : t('errors.saveFailed');
  }
}

async function clearJobs(): Promise<void> {
  clearing.value = true;
  clearError.value = null;
  try {
    const { cleared } = await jobsApi.clear(clearScope.value);
    await store.refresh();
    clearedCount.value = cleared;
    confirmingClear.value = false;
  } catch (error) {
    clearError.value = error instanceof Error ? error.message : t('errors.saveFailed');
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="jobs">
    <h1 class="jobs__title">{{ t('nav.jobs') }}</h1>

    <div class="jobs__filters">
      <v-text-field
        v-model="search"
        :placeholder="t('jobs.search')"
        prepend-inner-icon="search"
        density="compact"
        hide-details
        style="max-width: 320px"
      />
      <v-select
        v-model="stateFilter"
        :items="[
          { value: null, title: t('jobs.allStates') },
          { value: 'pending', title: t('status.queued') },
          { value: 'running', title: t('status.running') },
          { value: 'succeeded', title: t('status.succeeded') },
          { value: 'failed', title: t('status.failed') },
          { value: 'quarantined', title: t('status.quarantined') },
        ]"
        density="compact"
        hide-details
        style="max-width: 220px"
      />

      <v-spacer />

      <!-- Reads on what it will take, which the state filter narrows. Anything still queued or
           running is out of its reach, and the server enforces that rather than trusting this. -->
      <v-btn
        variant="tonal"
        prepend-icon="delete_sweep"
        :title="t('jobs.clearHint')"
        @click="openClear"
      >
        {{ clearScope === undefined ? t('jobs.clear') : t('jobs.clearFiltered') }}
      </v-btn>
    </div>

    <v-alert
      v-if="clearedCount !== null"
      type="success"
      variant="tonal"
      density="compact"
      closable
      class="mb-4"
      @click:close="clearedCount = null"
    >
      {{ t('jobs.cleared', { count: clearedCount }) }}
    </v-alert>

    <v-card>
      <v-table density="comfortable">
        <thead>
          <tr>
            <th>{{ t('jobs.file') }}</th>
            <th>{{ t('jobs.pipeline') }}</th>
            <th>{{ t('jobs.size') }}</th>
            <th>{{ t('jobs.pages') }}</th>
            <th>{{ t('jobs.device') }}</th>
            <th>{{ t('jobs.state') }}</th>
            <th class="text-right">{{ t('jobs.results') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="filtered.length === 0">
            <td colspan="7" class="text-center text-medium-emphasis py-8">
              {{ t('jobs.empty') }}
            </td>
          </tr>
          <tr v-for="job in filtered" :key="job.id" class="jobs__row" @click="openJob(job)">
            <td class="ocr-mono">{{ job.fileName }}</td>
            <td>
              <v-chip
                v-if="job.pipelineKind === 'quick'"
                size="x-small"
                color="primary"
                variant="tonal"
                label
              >
                {{ t('nav.quick') }}
              </v-chip>
              <span v-else>{{ pipelineLabel(job) }}</span>
            </td>
            <td class="ocr-mono">{{ formatSize(job.sizeBytes) }}</td>
            <td class="ocr-mono">{{ progress(job) }}</td>
            <td>
              <v-chip v-if="job.deviceUsed" size="x-small" variant="tonal" label>
                {{ t(`device.${job.deviceUsed}`) }}
              </v-chip>
              <span v-else>—</span>
            </td>
            <td><StatusChip :status="STATE_TO_CHIP[job.state]" dense /></td>
            <td class="text-right">
              <!-- Stops the row's own click handler opening the detail drawer behind the
                   download the user actually asked for. -->
              <v-btn
                v-if="canDownload(job)"
                icon="download"
                size="x-small"
                variant="text"
                :href="downloadUrl(job)"
                download
                :title="t('jobs.downloadResults')"
                @click.stop
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="confirmingClear" max-width="480">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ t('jobs.clearTitle') }}</v-card-title>
        <v-card-text>
          <v-alert v-if="clearError" type="error" density="compact" class="mb-3">
            {{ clearError }}
          </v-alert>
          <v-progress-circular v-else-if="clearable === null" indeterminate size="20" width="2" />
          <p v-else class="mb-2">
            {{
              clearScope === undefined
                ? t('jobs.clearBody', { count: clearable })
                : t('jobs.clearBodyFiltered', {
                    count: clearable,
                    state: t(`status.${STATE_TO_CHIP[clearScope]}`),
                  })
            }}
          </p>
          <p class="text-body-2 text-medium-emphasis mb-0">{{ t('jobs.clearKeeps') }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmingClear = false">{{ t('common.cancel') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            :loading="clearing"
            :disabled="clearable === null || clearable === 0"
            @click="clearJobs"
          >
            {{ t('jobs.clear') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <JobDetailDrawer
      :job="selected"
      :events="timeline"
      :chip-for="STATE_TO_CHIP"
      @close="selected = null"
      @retry="retry"
    />
  </div>
</template>

<style scoped>
.jobs__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 28px;
  font-weight: 500;
  margin: 0 0 20px;
}

.jobs__filters {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 16px;
}

.jobs__row {
  cursor: pointer;
}
</style>
