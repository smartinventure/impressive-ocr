<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDesktopBridge, type DataLocation } from '../../../composables/use-desktop-bridge';

/**
 * Where the runtime, models and database are kept, and how to move them.
 *
 * Worth a control rather than a documented environment variable because of the size: the
 * runtime is around 8 GB, and on Windows the app's own default lands on the system drive.
 * Anyone with a small SSD and a data drive needs somewhere to say so, and a support answer
 * of "set this variable and restart" is not one most people will follow.
 *
 * Desktop only. The headless server takes its location from `IMPRESSIVE_OCR_DATA_DIR` or a
 * volume mount, both fixed before the process starts, so a page offering to move it there
 * would be describing something it cannot do.
 */

const { t } = useI18n();
const desktop = useDesktopBridge();

const location = ref<DataLocation | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
/** Set after a change, because nothing moves until the app is started again. */
const restartNeeded = ref(false);

onMounted(load);

async function load(): Promise<void> {
  location.value = await desktop.getDataLocation();
}

async function choose(): Promise<void> {
  const picked = await desktop.selectFolder({
    title: t('dataLocation.chooseTitle'),
    allowCreate: true,
  });
  if (picked !== null) await apply(picked);
}

async function useDefault(): Promise<void> {
  await apply(null);
}

async function apply(dataDir: string | null): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    location.value = await desktop.setDataLocation(dataDir);
    restartNeeded.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : t('dataLocation.failed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-card v-if="desktop.isDesktop.value && location !== null" class="pa-5 mb-4">
    <h2 class="text-subtitle-1 font-weight-medium mb-1">{{ t('dataLocation.title') }}</h2>
    <p class="text-body-2 text-medium-emphasis mb-3">{{ t('dataLocation.subtitle') }}</p>

    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

    <!-- Said plainly rather than implied by a disabled button: someone who set the variable
         should learn why the control does nothing, not assume it is broken. -->
    <v-alert
      v-if="location.fromEnvironment"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ t('dataLocation.fromEnvironment') }}
    </v-alert>

    <v-alert
      v-else-if="restartNeeded"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ t('dataLocation.restartNeeded') }}
    </v-alert>

    <div class="data-location__path ocr-mono text-body-2 mb-1">{{ location.current }}</div>
    <p v-if="location.chosen === null" class="text-caption text-medium-emphasis mb-3">
      {{ t('dataLocation.usingDefault') }}
    </p>
    <p v-else class="text-caption text-medium-emphasis mb-3">
      {{ t('dataLocation.defaultIs', { path: location.default }) }}
    </p>

    <div class="d-flex ga-3 flex-wrap">
      <v-btn
        variant="tonal"
        color="primary"
        prepend-icon="folder_open"
        :disabled="location.fromEnvironment || busy"
        :loading="busy"
        @click="choose"
      >
        {{ t('dataLocation.change') }}
      </v-btn>
      <v-btn
        v-if="location.chosen !== null"
        variant="text"
        :disabled="location.fromEnvironment || busy"
        @click="useDefault"
      >
        {{ t('dataLocation.reset') }}
      </v-btn>
    </div>
  </v-card>
</template>

<style scoped>
/* Paths are long and must not push the card wide; they wrap at any character rather than
   only at separators, because a Windows path has few of those. */
.data-location__path {
  overflow-wrap: anywhere;
}
</style>
