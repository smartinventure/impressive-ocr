<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDesktopBridge, type UpdateStatus } from '../../../composables/use-desktop-bridge';

/**
 * The desktop updater's one visible surface.
 *
 * Everything behind it already existed — `UpdateService` checks, downloads and installs, and
 * the preload bridge exposed all three — but nothing in the SPA ever called them, so a user
 * could never learn that a release existed. This card is that missing half.
 *
 * Renders nothing in a browser. The headless server is updated by whatever installed it, and
 * offering a "Restart and install" button that cannot work would be worse than silence.
 */

const { t } = useI18n();
const desktop = useDesktopBridge();

const status = ref<UpdateStatus>({
  state: 'idle',
  version: null,
  progressPercent: 0,
  releaseNotesUrl: null,
  message: null,
});
const currentVersion = ref<string | null>(null);
const busy = ref(false);

let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  if (!desktop.isDesktop.value) {
    return;
  }
  // Subscribed before the first check, so a download already running when this page opens
  // shows its real progress rather than starting from "idle".
  unsubscribe = desktop.onUpdateStatus((next) => {
    status.value = next;
  });
  currentVersion.value = await desktop.getVersion();
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});

async function check(): Promise<void> {
  busy.value = true;
  try {
    const result = await desktop.checkForUpdate();
    if (result !== null) {
      status.value = result;
    }
  } finally {
    busy.value = false;
  }
}

async function download(): Promise<void> {
  busy.value = true;
  try {
    await desktop.downloadUpdate();
  } finally {
    busy.value = false;
  }
}

/**
 * Restarts the app. Deliberately a separate, explicit action rather than something that
 * happens on quit: a pipeline may be mid-document, and the user picks the moment.
 */
async function install(): Promise<void> {
  await desktop.installUpdate();
}
</script>

<template>
  <v-card v-if="desktop.isDesktop.value" class="pa-5 mb-4">
    <div class="d-flex align-center justify-space-between flex-wrap ga-3">
      <div>
        <h2 class="text-subtitle-1 font-weight-medium">{{ t('update.title') }}</h2>
        <p class="text-body-2 text-medium-emphasis mb-0">
          <template v-if="status.state === 'available' || status.state === 'ready'">
            {{ t('update.available', { version: status.version }) }}
          </template>
          <template v-else-if="status.state === 'checking'">{{ t('update.checking') }}</template>
          <template v-else-if="status.state === 'downloading'">
            {{ t('update.downloading') }}
          </template>
          <template v-else-if="status.state === 'up-to-date'">
            {{ t('update.upToDate', { version: currentVersion ?? '' }) }}
          </template>
          <template v-else-if="status.state === 'error'">
            {{ status.message ?? t('update.failed') }}
          </template>
          <template v-else>{{ t('update.current', { version: currentVersion ?? '' }) }}</template>
        </p>
      </div>

      <div class="d-flex ga-2">
        <v-btn
          v-if="status.state !== 'ready'"
          variant="tonal"
          :loading="busy || status.state === 'checking'"
          @click="check"
        >
          {{ t('update.check') }}
        </v-btn>
        <!-- Stays visible through the download so the button does not vanish mid-click. -->
        <v-btn
          v-if="status.state === 'available' || status.state === 'downloading'"
          color="primary"
          :loading="busy || status.state === 'downloading'"
          :disabled="status.state === 'downloading'"
          @click="download"
        >
          {{ t('update.download') }}
        </v-btn>
        <!-- Only once the bytes are on disk. Offering "install" mid-download would restart
             into the version the user already has. -->
        <v-btn v-if="status.state === 'ready'" color="primary" @click="install">
          {{ t('update.install') }}
        </v-btn>
      </div>
    </div>

    <v-progress-linear
      v-if="status.state === 'downloading'"
      :model-value="status.progressPercent"
      height="6"
      rounded
      class="mt-3"
    />

    <a
      v-if="
        status.releaseNotesUrl !== null &&
        (status.state === 'available' || status.state === 'ready')
      "
      :href="status.releaseNotesUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="text-body-2 d-inline-block mt-3"
    >
      {{ t('update.releaseNotes') }}
    </a>
  </v-card>
</template>
