<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppUpdate } from '../../../composables/use-app-update';

/**
 * The desktop updater's one visible surface.
 *
 * Everything behind it already existed -- `UpdateService` checks, downloads and installs, and
 * the preload bridge exposed all three -- but nothing in the SPA ever called them, so a user
 * could never learn that a release existed. This card is that missing half.
 *
 * The state lives in `use-app-update` rather than here, because the dashboard shows a short
 * notice about the same thing and two copies would mean two subscriptions, two checks, and
 * the chance of them disagreeing.
 *
 * Renders nothing in a browser. The headless server is updated by whatever installed it, and
 * offering a "Restart and install" button that cannot work would be worse than silence.
 */

const { t } = useI18n();
const update = useAppUpdate();

const desktop = { isDesktop: update.isDesktop };
const status = update.status;
const currentVersion = update.currentVersion;
const busy = update.busy;

onMounted(update.watch);
onUnmounted(update.unwatch);

const check = update.check;
const download = update.download;
const install = update.install;
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
