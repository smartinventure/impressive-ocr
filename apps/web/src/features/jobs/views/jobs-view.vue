<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Job, JobEvent, JobState } from '@impressive-ocr/shared';
import { jobsApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import StatusChip from '../../../components/status-chip.vue';
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

function pipelineName(job: Job): string {
  return store.pipelineById(job.pipelineId)?.name ?? '—';
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
    </div>

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
          </tr>
        </thead>
        <tbody>
          <tr v-if="filtered.length === 0">
            <td colspan="6" class="text-center text-medium-emphasis py-8">
              {{ t('jobs.empty') }}
            </td>
          </tr>
          <tr v-for="job in filtered" :key="job.id" class="jobs__row" @click="openJob(job)">
            <td class="ocr-mono">{{ job.fileName }}</td>
            <td>{{ pipelineName(job) }}</td>
            <td class="ocr-mono">{{ formatSize(job.sizeBytes) }}</td>
            <td class="ocr-mono">{{ progress(job) }}</td>
            <td>
              <v-chip v-if="job.deviceUsed" size="x-small" variant="tonal" label>
                {{ t(`device.${job.deviceUsed}`) }}
              </v-chip>
              <span v-else>—</span>
            </td>
            <td><StatusChip :status="STATE_TO_CHIP[job.state]" dense /></td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-navigation-drawer
      :model-value="selected !== null"
      location="right"
      temporary
      width="460"
      @update:model-value="selected = null"
    >
      <div v-if="selected" class="pa-5">
        <div class="d-flex align-center justify-space-between mb-3">
          <h2 class="text-h6 ocr-mono">{{ selected.fileName }}</h2>
          <v-btn icon="close" variant="text" size="small" @click="selected = null" />
        </div>

        <StatusChip :status="STATE_TO_CHIP[selected.state]" class="mb-4" />

        <div v-if="selected.deviceFallbackReason" class="ocr-alert-warning mb-4">
          {{ selected.deviceFallbackReason }}
        </div>
        <div v-if="selected.errorMessage" class="ocr-alert-error mb-4">
          {{ selected.errorMessage }}
        </div>

        <h3 class="text-subtitle-2 mb-2">{{ t('jobs.outputs') }}</h3>
        <p v-if="selected.outputs.length === 0" class="text-body-2 text-medium-emphasis mb-4">
          {{ t('jobs.noOutputs') }}
        </p>
        <v-list v-else density="compact" class="mb-4 py-0">
          <v-list-item v-for="output in selected.outputs" :key="output.path">
            <v-list-item-title class="ocr-mono">{{ output.format }}</v-list-item-title>
            <v-list-item-subtitle class="ocr-mono">{{ output.path }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>

        <h3 class="text-subtitle-2 mb-2">{{ t('jobs.timeline') }}</h3>
        <ol class="jobs__timeline">
          <li v-for="event in timeline" :key="event.id" :class="`jobs__event--${event.level}`">
            <span class="ocr-mono jobs__event-time">
              {{ new Date(event.createdAt).toLocaleTimeString() }}
            </span>
            <span>{{ event.message }}</span>
          </li>
        </ol>

        <v-btn
          v-if="selected.state === 'failed' || selected.state === 'quarantined'"
          color="primary"
          prepend-icon="replay"
          class="mt-4"
          @click="retry(selected)"
        >
          {{ t('common.retry') }}
        </v-btn>
      </div>
    </v-navigation-drawer>
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
  margin-bottom: 16px;
}

.jobs__row {
  cursor: pointer;
}

.jobs__timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.jobs__timeline li {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.jobs__event-time {
  color: var(--ocr-on-surface-muted);
  flex: none;
}

.jobs__event--error {
  color: rgb(var(--v-theme-failed));
}

.jobs__event--warning {
  color: rgb(var(--v-theme-paused));
}
</style>
