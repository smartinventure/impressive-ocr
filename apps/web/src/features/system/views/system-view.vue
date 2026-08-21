<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { systemApi, type HardwareWithExplanation } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import PreflightCard from '../components/preflight-card.vue';

/**
 * System status, and the place the OCR runtime gets installed.
 *
 * The runtime install is a multi-gigabyte download that runs for minutes, so progress is
 * driven by the event stream rather than the response — the request returns 202 immediately.
 */

const store = useLiveStore();
const { t } = useI18n();

const hardware = ref<HardwareWithExplanation | null>(null);
const installing = computed(() => store.runtime?.state === 'installing');

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function install(): Promise<void> {
  await systemApi.installRuntime();
}

async function reprobe(): Promise<void> {
  await systemApi.probeHardware();
  hardware.value = await systemApi.hardware();
}

onMounted(async () => {
  hardware.value = await systemApi.hardware();
});
</script>

<template>
  <div class="system">
    <h1 class="system__title">{{ t('nav.status') }}</h1>

    <!-- Compatibility, above the install button on purpose: the answer to "can this machine
         run it at all" is worth more than a progress bar on a download that cannot succeed. -->
    <PreflightCard />

    <!-- Runtime -->
    <v-card class="pa-5 mb-4">
      <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
        <h2 class="text-h6">{{ t('system.runtime') }}</h2>
        <v-chip
          size="small"
          label
          :color="store.runtimeReady ? 'succeeded' : installing ? 'running' : 'paused'"
        >
          {{ t(`runtimeState.${store.runtime?.state ?? 'not-installed'}`) }}
        </v-chip>
      </div>

      <p class="text-body-2 mb-3">{{ store.runtime?.message }}</p>

      <template v-if="installing">
        <v-progress-linear
          :model-value="store.runtime?.progressPercent ?? 0"
          color="running"
          height="8"
          rounded
          class="mb-2"
        />
        <p class="ocr-mono text-medium-emphasis">
          {{ store.runtime?.progressPercent ?? 0 }}% ·
          {{ t(`runtimeStep.${store.runtime?.currentStep ?? 'verify'}`) }}
        </p>
      </template>

      <div v-if="store.runtime?.errorMessage" class="ocr-alert-error mt-3">
        {{ store.runtime.errorMessage }}
      </div>

      <div v-if="!store.runtimeReady && !installing" class="mt-4">
        <v-btn color="primary" prepend-icon="download" @click="install">
          {{ t('runtime.install') }}
        </v-btn>
      </div>

      <dl v-if="store.runtimeReady" class="system__facts mt-3">
        <div>
          <dt>Python</dt>
          <dd class="ocr-mono">{{ store.runtime?.pythonVersion ?? '—' }}</dd>
        </div>
        <div>
          <dt>PaddleOCR</dt>
          <dd class="ocr-mono">{{ store.runtime?.paddleocrVersion ?? '—' }}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd class="ocr-mono">{{ store.runtime?.paddleFlavor ?? '—' }}</dd>
        </div>
      </dl>
    </v-card>

    <!-- Hardware -->
    <v-card class="pa-5 mb-4">
      <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
        <h2 class="text-h6">{{ t('system.hardware') }}</h2>
        <v-btn size="small" variant="text" prepend-icon="refresh" @click="reprobe">
          {{ t('system.reprobe') }}
        </v-btn>
      </div>

      <dl v-if="hardware" class="system__facts">
        <div>
          <dt>{{ t('system.cpu') }}</dt>
          <dd>{{ hardware.cpuModel }} · {{ hardware.cpuCores }} {{ t('system.cores') }}</dd>
        </div>
        <div>
          <dt>{{ t('system.memory') }}</dt>
          <dd>{{ formatBytes(hardware.totalMemoryBytes) }}</dd>
        </div>
        <div>
          <dt>{{ t('system.gpu') }}</dt>
          <dd v-if="hardware.gpu">
            {{ hardware.gpu.name }} · {{ formatBytes(hardware.gpu.vramBytes) }} ·
            {{ t('system.driver') }} {{ hardware.gpu.driverVersion }}
          </dd>
          <dd v-else>{{ t('system.noGpu') }}</dd>
        </div>
      </dl>

      <!-- The explanation is rendered by the server so the wizard and this screen agree
           word for word, and so a user who bought a GPU learns *why* it is not being used. -->
      <div v-if="hardware?.explanation" class="ocr-alert-warning mt-4">
        {{ hardware.explanation }}
      </div>
    </v-card>

    <!-- Workers -->
    <v-card class="pa-5">
      <h2 class="text-h6 mb-3">{{ t('system.workers') }}</h2>
      <p v-if="(store.system?.sidecars.length ?? 0) === 0" class="text-body-2 text-medium-emphasis">
        {{ t('system.noWorkers') }}
      </p>
      <v-table v-else density="compact">
        <thead>
          <tr>
            <th>{{ t('system.worker') }}</th>
            <th>{{ t('system.state') }}</th>
            <th>PID</th>
            <th>{{ t('system.restarts') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="worker in store.system?.sidecars ?? []" :key="worker.id">
            <td class="ocr-mono">{{ worker.id }}</td>
            <td>{{ worker.state }}</td>
            <td class="ocr-mono">{{ worker.pid ?? '—' }}</td>
            <td>{{ worker.restarts }}</td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
  </div>
</template>

<style scoped>
.system__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 28px;
  font-weight: 500;
  margin: 0 0 24px;
}

.system__facts {
  display: grid;
  gap: 10px;
  margin: 0;
}

.system__facts > div {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  align-items: baseline;
}

.system__facts dt {
  font-size: 13px;
  color: rgb(var(--v-theme-on-surface-variant));
}

.system__facts dd {
  margin: 0;
  font-size: 14px;
}

@media (max-width: 600px) {
  .system__facts > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
