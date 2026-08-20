<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PipelineWithStatus } from '@impressive-ocr/shared';
import { pipelinesApi, systemApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import StatusChip from '../../../components/status-chip.vue';
import type { StatusKey } from '../../../plugins/theme';

/**
 * The home screen: every pipeline with live counters and a play/pause control.
 *
 * Must stay readable with one pipeline and with fifteen, so it is a vertical list of cards
 * rather than a grid — a grid re-flows as the count changes and moves the row someone was
 * about to click.
 */

const store = useLiveStore();
const { t } = useI18n();

const pipelines = computed(() => store.pipelines);

/** Map a pipeline's own status onto the six-state chip vocabulary. */
function chipStatus(pipeline: PipelineWithStatus): StatusKey {
  if (pipeline.status === 'running') {
    return 'running';
  }
  if (!pipeline.enabled || store.globallyPaused) {
    return 'paused';
  }
  if (pipeline.status === 'blocked' || pipeline.status === 'error') {
    return 'failed';
  }
  return pipeline.stats.queued > 0 ? 'queued' : 'succeeded';
}

function progressPercent(pipeline: PipelineWithStatus): number {
  const { processed, total } = pipeline.stats;
  return total === 0 ? 0 : Math.round((processed / total) * 100);
}

async function toggle(pipeline: PipelineWithStatus): Promise<void> {
  const updated = pipeline.enabled
    ? await pipelinesApi.pause(pipeline.id)
    : await pipelinesApi.resume(pipeline.id);
  const index = store.pipelines.findIndex((item) => item.id === updated.id);
  if (index !== -1) {
    store.pipelines[index] = updated;
  }
}

async function toggleAll(): Promise<void> {
  await (store.globallyPaused ? systemApi.resumeAll() : systemApi.pauseAll());
  await store.refresh();
}
</script>

<template>
  <div class="pipelines">
    <header class="pipelines__header">
      <div>
        <h1 class="pipelines__title">{{ t('pipelines.title') }}</h1>
        <p class="pipelines__subtitle">{{ t('app.tagline') }}</p>
      </div>
      <div class="d-flex ga-2 align-center">
        <v-btn
          v-if="pipelines.length > 0"
          :prepend-icon="store.globallyPaused ? 'play_arrow' : 'pause'"
          variant="tonal"
          @click="toggleAll"
        >
          {{ store.globallyPaused ? t('pipelines.resumeAll') : t('pipelines.pauseAll') }}
        </v-btn>
        <v-tooltip
          v-if="!store.hasAuthorizedFolder"
          :text="t('pipelines.needsFolderTooltip')"
          location="bottom"
        >
          <template #activator="{ props: tooltip }">
            <!-- A span, because a disabled button emits no pointer events of its own and the
                 tooltip would never appear. -->
            <span v-bind="tooltip">
              <v-btn color="primary" prepend-icon="add" disabled>
                {{ t('pipelines.newPipeline') }}
              </v-btn>
            </span>
          </template>
        </v-tooltip>
        <v-btn v-else color="primary" prepend-icon="add" :to="{ name: 'pipeline-new' }">
          {{ t('pipelines.newPipeline') }}
        </v-btn>
      </div>
    </header>

    <v-alert
      v-if="!store.loading && !store.hasAuthorizedFolder"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
    >
      {{ t('pipelines.needsFolder') }}
      <template #append>
        <v-btn size="small" variant="text" :to="{ name: 'settings' }">
          {{ t('pipelines.goToSettings') }}
        </v-btn>
      </template>
    </v-alert>

    <v-alert v-if="store.globallyPaused" type="warning" density="compact" class="mb-4">
      {{ t('pipelines.allPaused') }}
    </v-alert>

    <v-alert v-if="store.loadError" type="error" density="compact" class="mb-4">
      {{ store.loadError }}
    </v-alert>

    <v-card v-if="!store.loading && pipelines.length === 0" class="pipelines__empty">
      <v-icon icon="account_tree" size="48" class="mb-3 text-medium-emphasis" />
      <h2 class="text-h6 mb-2">{{ t('pipelines.empty') }}</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ store.hasAuthorizedFolder ? t('pipelines.emptyHint') : t('pipelines.needsFolder') }}
      </p>
      <v-btn
        v-if="store.hasAuthorizedFolder"
        color="primary"
        prepend-icon="add"
        :to="{ name: 'pipeline-new' }"
      >
        {{ t('pipelines.newPipeline') }}
      </v-btn>
      <v-btn v-else color="primary" prepend-icon="folder_open" :to="{ name: 'settings' }">
        {{ t('pipelines.authorizeFolder') }}
      </v-btn>
    </v-card>

    <div v-else class="pipelines__list">
      <v-card v-for="pipeline in pipelines" :key="pipeline.id" class="pipeline-card">
        <div class="pipeline-card__main">
          <div class="pipeline-card__identity">
            <router-link
              :to="{ name: 'pipeline-detail', params: { id: pipeline.id } }"
              class="pipeline-card__name"
            >
              {{ pipeline.name }}
            </router-link>
            <div class="pipeline-card__paths">
              <span class="pipeline-card__path" :title="pipeline.options.source.inputPath">
                <v-icon icon="folder" size="14" />
                {{ pipeline.options.source.inputPath }}
              </span>
              <v-icon icon="arrow_forward" size="14" class="pipeline-card__arrow" />
              <span class="pipeline-card__path" :title="pipeline.options.output.outputPath">
                <v-icon icon="folder_open" size="14" />
                {{ pipeline.options.output.outputPath }}
              </span>
            </div>
          </div>

          <div class="pipeline-card__badges">
            <v-chip size="small" variant="tonal" label>
              {{ t(`profile.${pipeline.options.engine.profile}`) }}
            </v-chip>
            <v-chip
              size="small"
              variant="tonal"
              label
              :prepend-icon="
                pipeline.options.engine.device === 'cpu' ? 'developer_board' : 'memory'
              "
            >
              {{ t(`device.${pipeline.options.engine.device}`) }}
            </v-chip>
            <StatusChip :status="chipStatus(pipeline)" dense />
          </div>

          <v-btn
            :icon="pipeline.enabled ? 'pause' : 'play_arrow'"
            variant="tonal"
            size="small"
            :color="pipeline.enabled ? undefined : 'primary'"
            @click="toggle(pipeline)"
          />
        </div>

        <div class="pipeline-card__progress">
          <v-progress-linear
            :model-value="progressPercent(pipeline)"
            :color="pipeline.status === 'running' ? 'running' : 'succeeded'"
            height="6"
            rounded
            :bg-color="'surface-variant'"
          />
          <div class="pipeline-card__counters">
            <span>
              {{
                t('pipelines.counters', {
                  done: pipeline.stats.processed,
                  total: pipeline.stats.total,
                  queued: pipeline.stats.queued,
                })
              }}
            </span>
            <span v-if="pipeline.statusReason" class="pipeline-card__reason">
              {{ pipeline.statusReason }}
            </span>
          </div>
        </div>
      </v-card>
    </div>
  </div>
</template>

<style scoped>
.pipelines__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}

.pipelines__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.4px;
  margin: 0;
}

.pipelines__subtitle {
  margin: 4px 0 0;
  font-size: 14px;
  color: rgb(var(--v-theme-on-surface-variant));
}

.pipelines__empty {
  padding: 56px 32px;
  text-align: center;
}

.pipelines__list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pipeline-card {
  padding: 18px 20px;
}

.pipeline-card__main {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  flex-wrap: wrap;
}

.pipeline-card__identity {
  flex: 1 1 320px;
  min-width: 0;
}

.pipeline-card__name {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 17px;
  font-weight: 500;
  color: rgb(var(--v-theme-on-surface));
  text-decoration: none;
}

.pipeline-card__name:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

.pipeline-card__paths {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface-variant));
  min-width: 0;
}

.pipeline-card__path {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* Long UNC paths must truncate rather than push the badges off the card. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45%;
}

.pipeline-card__arrow {
  flex: none;
  opacity: 0.5;
}

.pipeline-card__badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pipeline-card__progress {
  margin-top: 16px;
}

.pipeline-card__counters {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-top: 8px;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface-variant));
  flex-wrap: wrap;
}

.pipeline-card__reason {
  color: var(--ocr-on-surface-muted);
}
</style>
