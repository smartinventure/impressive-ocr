<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Job, JobEvent, JobState } from '@impressive-ocr/shared';
import StatusChip from '../../../components/status-chip.vue';
import type { StatusKey } from '../../../plugins/theme';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';

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
const desktop = useDesktopBridge();

/**
 * Whether an output can be opened from here.
 *
 * Desktop only, and for the same reason Quick Mode draws the line there: these paths name
 * files on the machine running the service. In the desktop app that is this machine; in a
 * browser against a headless server it is somewhere else entirely, and a button that opens
 * nothing is worse than no button.
 */
const canOpenFiles = computed(() => desktop.isDesktop.value);

const openError = ref<string | null>(null);

async function openOutput(path: string): Promise<void> {
  openError.value = null;
  const result = await desktop.bridge.value?.openFile(path);
  if (result === undefined || result.status === 'opened') return;

  // Worth two different sentences: a file that has been moved or cleaned up is routine, and
  // a type we decline to launch is a deliberate limit rather than a failure.
  openError.value = result.reason === 'missing' ? t('jobs.openMissing') : t('jobs.openRefused');
}

async function revealOutput(path: string): Promise<void> {
  await desktop.bridge.value?.showInFolder(path);
}
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

      <v-alert v-if="openError" type="warning" density="compact" class="mb-2">
        {{ openError }}
      </v-alert>
      <p v-if="job.outputs.length === 0" class="text-body-2 text-medium-emphasis mb-4">
        {{ t('jobs.noOutputs') }}
      </p>
      <v-list v-else density="compact" class="mb-4 py-0">
        <v-list-item
          v-for="output in job.outputs"
          :key="output.path"
          :class="{ 'job-detail__output--openable': canOpenFiles }"
          @click="canOpenFiles ? openOutput(output.path) : undefined"
        >
          <v-list-item-title class="ocr-mono">{{ output.format }}</v-list-item-title>
          <v-list-item-subtitle class="ocr-mono">{{ output.path }}</v-list-item-subtitle>
          <!-- Desktop only. In a browser the path names a file on the machine running the
               service, which need not be the one reading this page - offering to open it
               would do nothing and look broken. -->
          <template v-if="canOpenFiles" #append>
            <v-btn
              icon="folder_open"
              variant="text"
              density="comfortable"
              size="small"
              :title="t('jobs.showInFolder')"
              @click.stop="revealOutput(output.path)"
            />
          </template>
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
/* Only when it actually does something: the same row is inert in a browser. */
.job-detail__output--openable {
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
