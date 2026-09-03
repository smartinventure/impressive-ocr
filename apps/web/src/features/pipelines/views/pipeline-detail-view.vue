<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { PipelineWithStatus } from '@impressive-ocr/shared';
import { pipelinesApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import StatusChip from '../../../components/status-chip.vue';
import type { StatusKey } from '../../../plugins/theme';

/** One pipeline: what is running now, what is waiting, and what it has finished with. */

const props = defineProps<{ id: string }>();

const store = useLiveStore();
const router = useRouter();
const { t } = useI18n();

const fetched = ref<PipelineWithStatus | null>(null);
const pipeline = computed(() => store.pipelineById(props.id) ?? fetched.value);
const confirmingDelete = ref(false);

const jobs = computed(() => store.jobsForPipeline(props.id));
const running = computed(() => jobs.value.filter((job) => job.state === 'running'));
const queued = computed(() =>
  jobs.value.filter((job) => job.state === 'pending' || job.state === 'discovered'),
);
const recent = computed(() => jobs.value.filter((job) => job.finishedAt !== null).slice(0, 12));

const STATS: {
  key: StatusKey;
  field: 'queued' | 'running' | 'succeeded' | 'failed' | 'quarantined';
}[] = [
  { key: 'queued', field: 'queued' },
  { key: 'running', field: 'running' },
  { key: 'succeeded', field: 'succeeded' },
  { key: 'failed', field: 'failed' },
  { key: 'quarantined', field: 'quarantined' },
];

async function toggle(): Promise<void> {
  if (pipeline.value === null) {
    return;
  }
  await (pipeline.value.enabled ? pipelinesApi.pause(props.id) : pipelinesApi.resume(props.id));
  await store.refresh();
}

async function remove(): Promise<void> {
  await pipelinesApi.remove(props.id);
  await store.refresh();
  await router.push({ name: 'pipelines' });
}

onMounted(async () => {
  if (store.pipelineById(props.id) === undefined) {
    fetched.value = await pipelinesApi.get(props.id);
  }
});
</script>

<template>
  <div v-if="pipeline" class="detail">
    <header class="detail__header">
      <v-btn icon="arrow_back" variant="text" size="small" :to="{ name: 'pipelines' }" />
      <div class="flex-grow-1">
        <h1 class="detail__title">{{ pipeline.name }}</h1>
        <p v-if="pipeline.description" class="detail__description">{{ pipeline.description }}</p>
      </div>
      <v-btn
        :prepend-icon="pipeline.enabled ? 'pause' : 'play_arrow'"
        variant="tonal"
        @click="toggle"
      >
        {{ pipeline.enabled ? t('detail.pause') : t('detail.resume') }}
      </v-btn>
      <!-- The same rule as the list: a pipeline is edited and deleted while paused. Enforcing
           it in one place only would make it a suggestion, since this page is one click from
           that one. -->
      <!-- The hint sits on a wrapping span, not on the button: a disabled button emits no
           pointer events, so a tooltip bound to it never opens and the control would grey out
           with no explanation. -->
      <span :title="pipeline.enabled ? t('pipelines.pauseFirst') : t('common.edit')">
        <v-btn
          prepend-icon="edit"
          variant="tonal"
          :disabled="pipeline.enabled"
          :to="
            pipeline.enabled ? undefined : { name: 'pipeline-edit', params: { id: pipeline.id } }
          "
        >
          {{ t('common.edit') }}
        </v-btn>
      </span>
      <span :title="pipeline.enabled ? t('pipelines.pauseFirst') : t('common.delete')">
        <v-btn
          icon="delete"
          variant="text"
          color="failed"
          :disabled="pipeline.enabled"
          @click="confirmingDelete = true"
        />
      </span>
    </header>

    <div v-if="pipeline.statusReason" class="ocr-alert-warning mb-4">
      {{ pipeline.statusReason }}
    </div>

    <div class="detail__stats">
      <v-card v-for="stat in STATS" :key="stat.key" class="detail__stat">
        <span class="detail__stat-value">{{ pipeline.stats[stat.field] }}</span>
        <StatusChip :status="stat.key" dense />
      </v-card>
    </div>

    <v-card class="pa-5 mb-4">
      <h2 class="text-h6 mb-3">{{ t('detail.nowProcessing') }}</h2>
      <p v-if="running.length === 0" class="text-body-2 text-medium-emphasis">
        {{ t('detail.idle') }}
      </p>
      <div v-for="job in running" :key="job.id" class="detail__running">
        <div class="d-flex justify-space-between align-baseline ga-3 flex-wrap">
          <span class="ocr-mono">{{ job.fileName }}</span>
          <span class="ocr-mono text-medium-emphasis">
            {{ job.pagesDone }} {{ t('common.of') }} {{ job.pageCount ?? '?' }}
          </span>
        </div>
        <v-progress-linear
          :model-value="job.pageCount ? (job.pagesDone / job.pageCount) * 100 : 0"
          color="running"
          height="6"
          rounded
          class="mt-2"
        />
      </div>
    </v-card>

    <v-card class="pa-5 mb-4">
      <h2 class="text-h6 mb-3">
        {{ t('detail.queue') }}
        <span class="text-body-2 text-medium-emphasis">({{ queued.length }})</span>
      </h2>
      <p v-if="queued.length === 0" class="text-body-2 text-medium-emphasis">
        {{ t('detail.queueEmpty') }}
      </p>
      <ol v-else class="detail__queue">
        <li v-for="job in queued.slice(0, 10)" :key="job.id" class="ocr-mono">
          {{ job.fileName }}
        </li>
      </ol>
    </v-card>

    <v-card class="pa-5">
      <h2 class="text-h6 mb-3">{{ t('detail.recent') }}</h2>
      <p v-if="recent.length === 0" class="text-body-2 text-medium-emphasis">
        {{ t('detail.noHistory') }}
      </p>
      <v-table v-else density="compact">
        <tbody>
          <tr v-for="job in recent" :key="job.id">
            <td class="ocr-mono">{{ job.fileName }}</td>
            <td class="ocr-mono">{{ job.pageCount ?? '—' }}</td>
            <td>
              <StatusChip
                :status="
                  job.state === 'succeeded'
                    ? 'succeeded'
                    : job.state === 'quarantined'
                      ? 'quarantined'
                      : 'failed'
                "
                dense
              />
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <v-dialog v-model="confirmingDelete" max-width="440">
      <v-card class="pa-5">
        <h2 class="text-h6 mb-2">{{ t('detail.deleteTitle') }}</h2>
        <p class="text-body-2 mb-4">{{ t('detail.deleteBody', { name: pipeline.name }) }}</p>
        <div class="d-flex justify-end ga-2">
          <v-btn variant="text" @click="confirmingDelete = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="failed" @click="remove">{{ t('common.delete') }}</v-btn>
        </div>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.detail__header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.detail__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 26px;
  font-weight: 500;
  margin: 0;
}

.detail__description {
  margin: 4px 0 0;
  font-size: 14px;
  color: rgb(var(--v-theme-on-surface-variant));
}

.detail__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.detail__stat {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}

.detail__stat-value {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 26px;
  font-weight: 500;
  line-height: 1;
}

.detail__running + .detail__running {
  margin-top: 16px;
}

.detail__queue {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
