<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  APP_VERSION,
  type RuntimeInstallPlan,
  type SidecarReleaseResult,
} from '@impressive-ocr/shared';
import { systemApi, type HardwareWithExplanation } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import PreflightCard from '../components/preflight-card.vue';
import UpdateCard from '../components/update-card.vue';
import DataLocationCard from '../components/data-location-card.vue';
import LicenseCard from '../components/license-card.vue';

/**
 * System status, and the place the OCR runtime gets installed.
 *
 * The runtime install is a multi-gigabyte download that runs for minutes, so progress is
 * driven by the event stream rather than the response — the request returns 202 immediately.
 */

const store = useLiveStore();
const { t } = useI18n();

/** What the application ships, against which the installed engine is compared. */
const appVersion = APP_VERSION;

const refreshing = ref(false);
const refreshError = ref<string | null>(null);
/**
 * What the last check found.
 *
 * The button reinstalls the engine unconditionally, so on an up-to-date installation it did
 * its work and changed nothing visible -- the label read the same before and after, and the
 * only honest conclusion available to the user was that the button was broken. Saying which
 * of the two things happened costs one line and is the entire difference.
 */
const refreshResult = ref<string | null>(null);

/**
 * The engine's Python is a *copy* in the venv, not the source the app ships. It only changes
 * when something reinstalls it, so after an app update these two numbers disagree and the OCR
 * keeps running the old code.
 */
const engineOutdated = computed(() => {
  // Null means "not recorded yet", which the backfill resolves on the next start. Treating it
  // as outdated would nag about a runtime nobody has measured.
  const installed = store.runtime?.sidecarVersion ?? null;
  return installed !== null && installed !== appVersion;
});

async function refreshEngine(): Promise<void> {
  refreshing.value = true;
  refreshError.value = null;
  refreshResult.value = null;
  // Read before the reinstall, which is what makes them agree afterwards.
  const wasOutdated = engineOutdated.value;
  try {
    await systemApi.refreshSidecar();
    await store.refresh();
    refreshResult.value = wasOutdated
      ? t('runtime.engineUpdated', { version: appVersion })
      : t('runtime.engineUpToDate', { version: appVersion });
  } catch (error) {
    refreshError.value = error instanceof Error ? error.message : t('errors.saveFailed');
  } finally {
    refreshing.value = false;
  }
}

/**
 * Installing the fast inference engine into a runtime that predates it.
 *
 * Offered here because such an installation is already `ready` and will never run the
 * installer again, so without this it stays on the slow backend permanently -- and nothing
 * on screen would explain why the accurate profile is a minute a page.
 */
const installingEngine = ref(false);
const engineError = ref<string | null>(null);
const vlServerMissing = computed(
  () => store.runtimeReady && store.runtime?.vlServerInstalled === false,
);

async function installFastEngine(): Promise<void> {
  installingEngine.value = true;
  engineError.value = null;
  try {
    await systemApi.installVlServer();
    await store.refresh();
  } catch (error) {
    engineError.value = error instanceof Error ? error.message : t('errors.saveFailed');
  } finally {
    installingEngine.value = false;
  }
}

const hardware = ref<HardwareWithExplanation | null>(null);
const installing = computed(() => store.runtime?.state === 'installing');

/**
 * Nothing is downloaded until this plan has been shown and accepted.
 *
 * The build is chosen from a hardware probe the user never sees, and the CPU and GPU wheels
 * differ by most of a gigabyte — starting that on someone's connection unannounced is not on.
 */
const plan = ref<RuntimeInstallPlan | null>(null);
const planPending = ref(false);
const planError = ref<string | null>(null);
const confirmOpen = ref(false);

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function askToInstall(): Promise<void> {
  planPending.value = true;
  planError.value = null;
  try {
    plan.value = await systemApi.runtimePlan();
    confirmOpen.value = true;
  } catch {
    planError.value = t('runtime.planFailed');
  } finally {
    planPending.value = false;
  }
}

async function confirmInstall(): Promise<void> {
  confirmOpen.value = false;
  await systemApi.installRuntime();
}

/**
 * Releasing the workers.
 *
 * A warm worker holds its models for as long as the app runs — several gigabytes of VRAM on
 * the GPU. Releasing costs the next document its model load, so it is a deliberate act with a
 * button rather than something that happens quietly.
 */
const releasing = ref(false);
const releaseResult = ref<SidecarReleaseResult | null>(null);
const forceDialogOpen = ref(false);

const workers = computed(() => store.system?.sidecars ?? []);
const busyWorkers = computed(() => workers.value.filter((worker) => worker.state === 'busy'));
const hasWorkers = computed(() => workers.value.length > 0);

async function release(force: boolean): Promise<void> {
  releasing.value = true;
  releaseResult.value = null;
  try {
    releaseResult.value = await systemApi.releaseSidecars(force);
  } finally {
    releasing.value = false;
    forceDialogOpen.value = false;
  }
}

function askToRelease(): void {
  // Mid-document is the case worth stopping for: forcing costs the work already done, and
  // the job restarts from the first page.
  if (busyWorkers.value.length > 0) {
    forceDialogOpen.value = true;
    return;
  }
  void release(false);
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

    <!-- And below it, whether the app itself is current. Desktop only; renders nothing in a
         browser or on the headless server, which are updated by whatever installed them. -->
    <update-card />

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
        <v-btn color="primary" prepend-icon="download" :loading="planPending" @click="askToInstall">
          {{ t('runtime.install') }}
        </v-btn>
        <div v-if="planError" class="ocr-alert-error mt-3">{{ planError }}</div>
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
        <div>
          <dt>{{ t('runtime.engineVersion') }}</dt>
          <dd class="ocr-mono">{{ store.runtime?.sidecarVersion ?? '—' }}</dd>
        </div>
      </dl>

      <!-- The sidecar is copied into the venv once and never touched again, so an app update
           leaves the engine running the previous Python. Nothing else would show that. -->
      <div v-if="store.runtimeReady && engineOutdated" class="ocr-alert-warning mt-4">
        {{
          t('runtime.engineOutdated', {
            engine: store.runtime?.sidecarVersion ?? '—',
            app: appVersion,
          })
        }}
      </div>

      <div v-if="store.runtimeReady" class="mt-3">
        <v-btn
          size="small"
          variant="tonal"
          :color="engineOutdated ? 'primary' : undefined"
          prepend-icon="autorenew"
          :loading="refreshing"
          @click="refreshEngine"
        >
          {{ t('runtime.checkForUpdates') }}
        </v-btn>
        <span class="text-body-2 text-medium-emphasis ml-3">{{
          t('runtime.updateEngineHint')
        }}</span>
        <div v-if="refreshError" class="ocr-alert-error mt-3">{{ refreshError }}</div>
        <v-alert
          v-else-if="refreshResult"
          type="success"
          variant="tonal"
          density="compact"
          class="mt-3"
        >
          {{ refreshResult }}
        </v-alert>
      </div>

      <!-- Absent only on installations set up before this engine existed. Everything still
           works without it; it is just ~28x slower, which is worth one prompt. -->
      <div v-if="vlServerMissing" class="ocr-alert-warning mt-4">
        {{ t('runtime.vlServerMissing') }}
        <div class="mt-3">
          <v-btn
            size="small"
            variant="tonal"
            color="primary"
            prepend-icon="bolt"
            :loading="installingEngine"
            @click="installFastEngine"
          >
            {{ t('runtime.installVlServer') }}
          </v-btn>
          <span class="text-body-2 text-medium-emphasis ml-3">{{
            t('runtime.installVlServerHint')
          }}</span>
        </div>
        <div v-if="engineError" class="ocr-alert-error mt-3">{{ engineError }}</div>
      </div>
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

    <!-- Which licence this installation runs under. Reachable after first run, because that
         step can be skipped and someone replacing a machine has to release its seat. -->
    <LicenseCard />

    <!-- Where the ~8 GB runtime lives. Desktop only; the card hides itself in a browser. -->
    <DataLocationCard />

    <!-- Workers -->
    <v-card class="pa-5">
      <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
        <h2 class="text-h6">{{ t('system.workers') }}</h2>
        <v-btn
          v-if="hasWorkers"
          size="small"
          variant="outlined"
          prepend-icon="memory"
          :loading="releasing"
          @click="askToRelease"
        >
          {{ t('system.release') }}
        </v-btn>
      </div>

      <p v-if="hasWorkers" class="text-body-2 text-medium-emphasis mb-3">
        {{ t('system.releaseHint') }}
      </p>

      <v-alert v-if="releaseResult" type="success" variant="tonal" density="compact" class="mb-3">
        {{ t('system.released', { count: releaseResult.stopped }) }}
        <template v-if="releaseResult.busy > 0">
          {{ t('system.releaseSkipped', { count: releaseResult.busy }) }}
        </template>
      </v-alert>

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
    <!-- Releasing while a document is being processed throws that work away, so it is asked
         about rather than assumed. -->
    <v-dialog v-model="forceDialogOpen" max-width="480">
      <v-card class="pa-5">
        <h2 class="text-h6 mb-2">{{ t('system.releaseBusyTitle') }}</h2>
        <p class="text-body-2 mb-4">
          {{ t('system.releaseBusyBody', { count: busyWorkers.length }) }}
        </p>
        <div class="d-flex justify-end ga-2">
          <v-btn variant="text" @click="forceDialogOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="releasing" @click="release(true)">
            {{ t('system.releaseAnyway') }}
          </v-btn>
        </div>
      </v-card>
    </v-dialog>

    <!-- Pre-install confirmation. Nothing is downloaded before this is accepted. -->
    <v-dialog v-model="confirmOpen" max-width="560">
      <v-card v-if="plan" class="pa-5">
        <h2 class="text-h6 mb-2">{{ t('runtime.confirmTitle') }}</h2>
        <p class="text-body-2 mb-4">{{ plan.rationale }}</p>

        <dl class="system__facts mb-4">
          <div>
            <dt>{{ t('runtime.build') }}</dt>
            <dd class="ocr-mono">{{ plan.description }}</dd>
          </div>
          <div>
            <dt>{{ t('runtime.download') }}</dt>
            <dd class="ocr-mono">
              {{ t('runtime.about', { size: formatBytes(plan.downloadBytes) }) }}
            </dd>
          </div>
          <div>
            <dt>{{ t('runtime.onDisk') }}</dt>
            <dd class="ocr-mono">
              {{ t('runtime.about', { size: formatBytes(plan.installedBytes) }) }}
            </dd>
          </div>
          <div>
            <dt>{{ t('runtime.location') }}</dt>
            <dd class="ocr-mono">{{ plan.targetPath }}</dd>
          </div>
          <div v-if="plan.freeBytes !== null">
            <dt>{{ t('runtime.freeSpace') }}</dt>
            <dd class="ocr-mono">{{ formatBytes(plan.freeBytes) }}</dd>
          </div>
        </dl>

        <v-alert v-if="!plan.enoughSpace" type="warning" density="compact" class="mb-4">
          {{ t('runtime.tightSpace') }}
        </v-alert>
        <p class="text-body-2 text-medium-emphasis mb-4">{{ t('runtime.confirmNote') }}</p>

        <div class="d-flex justify-end ga-2">
          <v-btn variant="text" @click="confirmOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" prepend-icon="download" @click="confirmInstall">
            {{ t('runtime.confirmStart') }}
          </v-btn>
        </div>
      </v-card>
    </v-dialog>
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
