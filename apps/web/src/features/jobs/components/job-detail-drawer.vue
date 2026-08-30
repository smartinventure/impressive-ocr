<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Job, JobEvent, JobState } from '@impressive-ocr/shared';
import StatusChip from '../../../components/status-chip.vue';
import type { StatusKey } from '../../../plugins/theme';

/**
 * One job in full: what it produced, and the page-by-page timeline of how it went.
 *
 * Its own component because it is the half of the Jobs page that is *not* the list — the list
 * is a table with filters and one destructive action, this is a read-only record — and keeping
 * both in one file put that file well past the size the house rules allow.
 */

defineProps<{
  /** The job to show, or null when the drawer is closed. */
  job: Job | null;
  events: JobEvent[];
  /** Shared with the list, so a state never reads as one colour here and another there. */
  chipFor: Record<JobState, StatusKey>;
}>();

const emit = defineEmits<{ close: []; retry: [Job] }>();

const { t } = useI18n();
</script>

<template>
  <v-navigation-drawer
    :model-value="job !== null"
    location="right"
    temporary
    width="460"
    @update:model-value="emit('close')"
  >
    <div v-if="job" class="pa-5">
      <div class="d-flex align-center justify-space-between mb-3">
        <h2 class="text-h6 ocr-mono">{{ job.fileName }}</h2>
        <v-btn icon="close" variant="text" size="small" @click="emit('close')" />
      </div>

      <StatusChip :status="chipFor[job.state]" class="mb-4" />

      <div v-if="job.deviceFallbackReason" class="ocr-alert-warning mb-4">
        {{ job.deviceFallbackReason }}
      </div>
      <div v-if="job.errorMessage" class="ocr-alert-error mb-4">
        {{ job.errorMessage }}
      </div>

      <h3 class="text-subtitle-2 mb-2">{{ t('jobs.outputs') }}</h3>
      <p v-if="job.outputs.length === 0" class="text-body-2 text-medium-emphasis mb-4">
        {{ t('jobs.noOutputs') }}
      </p>
      <v-list v-else density="compact" class="mb-4 py-0">
        <v-list-item v-for="output in job.outputs" :key="output.path">
          <v-list-item-title class="ocr-mono">{{ output.format }}</v-list-item-title>
          <v-list-item-subtitle class="ocr-mono">{{ output.path }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>

      <h3 class="text-subtitle-2 mb-2">{{ t('jobs.timeline') }}</h3>
      <ol class="jobs__timeline">
        <li v-for="event in events" :key="event.id" :class="`jobs__event--${event.level}`">
          <span class="ocr-mono jobs__event-time">
            {{ new Date(event.createdAt).toLocaleTimeString() }}
          </span>
          <span>{{ event.message }}</span>
        </li>
      </ol>

      <v-btn
        v-if="job.state === 'failed' || job.state === 'quarantined'"
        color="primary"
        prepend-icon="replay"
        class="mt-4"
        @click="emit('retry', job)"
      >
        {{ t('common.retry') }}
      </v-btn>
    </div>
  </v-navigation-drawer>
</template>

<style scoped>
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
