<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { dashboardApi, type DashboardSnapshot } from '../../../api/endpoints';
import CompatibilityBanner from '../../../components/compatibility-banner.vue';

/**
 * The overview: what the machine is doing, and what it has got through.
 *
 * CPU and memory sit side by side deliberately. The failure this product actually hits is
 * swapping — memory near 100% while CPU reads 20% — and either number alone looks like an
 * idle machine.
 */

const { t } = useI18n();

const snapshot = ref<DashboardSnapshot | null>(null);
const error = ref<string | null>(null);

/** Slow enough to be free, fast enough that memory pressure is visible as it builds. */
const POLL_INTERVAL_MS = 4000;

let timer: ReturnType<typeof setInterval> | undefined;

const memoryPercent = computed(() =>
  Math.round((snapshot.value?.resources.memoryUsedFraction ?? 0) * 100),
);

const cpuPercent = computed(() => {
  const busy = snapshot.value?.resources.cpuBusyFraction;
  return busy === null || busy === undefined ? null : Math.round(busy * 100);
});

/** Above this, a document starts taking minutes per page because the machine is swapping. */
const memoryPressure = computed(() => memoryPercent.value >= 90);

const gpu = computed(() => snapshot.value?.hardware.gpu ?? null);

function gigabytes(bytes: number | undefined): string {
  return bytes === undefined ? '—' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function refresh(): Promise<void> {
  try {
    snapshot.value = await dashboardApi.get();
    error.value = null;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : t('dashboard.loadFailed');
  }
}

onMounted(async () => {
  await refresh();
  timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <div class="dashboard">
    <header class="dashboard__header">
      <h1 class="dashboard__title">{{ t('nav.dashboard') }}</h1>
    </header>

    <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>

    <!-- Whether the engine can run here at all, and what is missing if not. First thing on
         the page, because it decides whether anything below it matters. -->
    <CompatibilityBanner />

    <!-- Stated plainly, because every symptom of an emulated platform looks like a bug in
         this application rather than a machine that cannot run the workload. -->
    <v-alert
      v-if="snapshot && snapshot.platform.support !== 'native'"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-4"
    >
      {{ snapshot.platform.reason }}
    </v-alert>

    <!-- Machine -->
    <div class="dashboard__grid mb-4">
      <v-card class="pa-4">
        <div class="text-caption text-medium-emphasis mb-1">{{ t('dashboard.cpu') }}</div>
        <div class="dashboard__figure">
          {{ cpuPercent === null ? '—' : `${cpuPercent}%` }}
        </div>
        <v-progress-linear
          :model-value="cpuPercent ?? 0"
          height="6"
          rounded
          color="primary"
          class="mt-2"
        />
        <div class="text-caption text-medium-emphasis mt-2">
          {{ snapshot?.hardware.cpuModel ?? '' }}
        </div>
        <div class="text-caption text-medium-emphasis">
          {{ t('dashboard.cores', { count: snapshot?.hardware.cpuCores ?? 0 }) }}
        </div>
      </v-card>

      <v-card class="pa-4">
        <div class="text-caption text-medium-emphasis mb-1">{{ t('dashboard.memory') }}</div>
        <div class="dashboard__figure" :class="memoryPressure ? 'dashboard__figure--warn' : ''">
          {{ memoryPercent }}%
        </div>
        <v-progress-linear
          :model-value="memoryPercent"
          height="6"
          rounded
          :color="memoryPressure ? 'failed' : 'primary'"
          class="mt-2"
        />
        <div class="text-caption text-medium-emphasis mt-2">
          {{
            t('dashboard.memoryDetail', {
              free: gigabytes(snapshot?.resources.freeMemoryBytes),
              total: gigabytes(snapshot?.resources.totalMemoryBytes),
            })
          }}
        </div>
        <!-- The one number that explains "CPU is low but everything is slow". -->
        <div v-if="memoryPressure" class="text-caption mt-1 dashboard__warn">
          {{ t('dashboard.memoryPressure') }}
        </div>
      </v-card>

      <v-card class="pa-4">
        <div class="text-caption text-medium-emphasis mb-1">{{ t('dashboard.engine') }}</div>
        <div class="dashboard__figure">
          {{ (snapshot?.runtime.device ?? 'cpu').toUpperCase() }}
        </div>
        <div class="text-caption text-medium-emphasis mt-2">
          {{ gpu === null ? t('dashboard.noGpu') : gpu.name }}
        </div>
        <div v-if="gpu !== null" class="text-caption text-medium-emphasis">
          {{ gigabytes(gpu.vramBytes) }} VRAM
        </div>
        <div v-else class="text-caption text-medium-emphasis">
          {{ snapshot?.hardware.gpuUnavailableReason ?? '' }}
        </div>
      </v-card>

      <v-card class="pa-4">
        <div class="text-caption text-medium-emphasis mb-1">
          {{ t('dashboard.processed', { hours: snapshot?.windowHours ?? 24 }) }}
        </div>
        <div class="dashboard__figure">{{ snapshot?.throughput.succeeded ?? 0 }}</div>
        <div class="text-caption text-medium-emphasis mt-2">
          {{ t('dashboard.pagesCount', { count: snapshot?.throughput.pages ?? 0 }) }}
        </div>
        <div
          v-if="(snapshot?.throughput.failed ?? 0) + (snapshot?.throughput.quarantined ?? 0) > 0"
          class="text-caption dashboard__warn"
        >
          {{
            t('dashboard.failedCount', {
              count: (snapshot?.throughput.failed ?? 0) + (snapshot?.throughput.quarantined ?? 0),
            })
          }}
        </div>
      </v-card>
    </div>

    <!-- Pipelines -->
    <v-card class="pa-5">
      <h2 class="text-subtitle-1 font-weight-medium mb-3">{{ t('dashboard.pipelines') }}</h2>

      <p v-if="(snapshot?.pipelines.length ?? 0) === 0" class="text-body-2 text-medium-emphasis">
        {{ t('dashboard.noPipelines') }}
      </p>

      <v-table v-else density="compact">
        <thead>
          <tr>
            <th>{{ t('dashboard.name') }}</th>
            <th>{{ t('dashboard.input') }}</th>
            <th>{{ t('dashboard.output') }}</th>
            <th>{{ t('dashboard.settings') }}</th>
            <th class="text-right">{{ t('dashboard.queued') }}</th>
            <th class="text-right">{{ t('dashboard.done') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pipeline in snapshot?.pipelines ?? []" :key="pipeline.id">
            <td>
              <router-link
                class="dashboard__link"
                :to="{ name: 'pipeline-detail', params: { id: pipeline.id } }"
              >
                {{ pipeline.name }}
              </router-link>
              <v-chip v-if="!pipeline.enabled" size="x-small" class="ml-2" label>
                {{ t('dashboard.paused') }}
              </v-chip>
            </td>
            <td class="dashboard__path">{{ pipeline.inputPath }}</td>
            <td class="dashboard__path">{{ pipeline.outputPath }}</td>
            <td class="text-caption">
              {{ pipeline.profile }} &middot; {{ pipeline.formats.join(', ') }}
            </td>
            <td class="text-right">{{ pipeline.stats.queued }}</td>
            <td class="text-right">{{ pipeline.stats.succeeded }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
  </div>
</template>

<style scoped>
.dashboard__header {
  margin-bottom: 20px;
}

.dashboard__title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.dashboard__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.dashboard__figure {
  font-size: 1.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.dashboard__figure--warn,
.dashboard__warn {
  color: rgb(var(--v-theme-failed));
}

/* Paths are read character by character when something is wrong. */
.dashboard__path {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dashboard__link {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}

.dashboard__link:hover {
  text-decoration: underline;
}
</style>
