<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { OutputFormat } from '@impressive-ocr/shared';
import { useLiveStore } from '../../../stores/live-store';
import { useQuickRun } from '../composables/use-quick-run';
import FileSourcePicker from '../components/file-source-picker.vue';
import FolderPickerField from '../../../components/folder-picker-field.vue';

/**
 * Quick Mode: OCR a handful of files once.
 *
 * A pipeline is the right shape for "watch this folder forever" and the wrong shape for "I
 * have three PDFs". This screen is the second case and nothing more — deliberately a trimmed
 * option set, with the pipeline editor still the place for the full thirty.
 */

const { t } = useI18n();
const store = useLiveStore();
const quick = useQuickRun();

/** The formats worth offering without a pipeline. The editor exposes the rest. */
const FORMATS: { value: OutputFormat; labelKey: string }[] = [
  { value: 'markdown', labelKey: 'format.markdown' },
  { value: 'json', labelKey: 'format.json' },
  { value: 'txt', labelKey: 'format.txt' },
  { value: 'docx', labelKey: 'format.docx' },
  { value: 'xlsx', labelKey: 'format.xlsx' },
];

function toggleFormat(format: OutputFormat): void {
  const current = quick.options.value.formats;
  // Never let the last one go: a run producing nothing is not a state worth allowing.
  const next = current.includes(format)
    ? current.filter((item) => item !== format)
    : [...current, format];
  if (next.length > 0) {
    quick.options.value = { ...quick.options.value, formats: next };
  }
}
</script>

<template>
  <div class="quick">
    <header class="quick__header">
      <h1 class="quick__title">{{ t('nav.quick') }}</h1>
      <p class="text-body-2 text-medium-emphasis">{{ t('quick.subtitle') }}</p>
    </header>

    <v-alert v-if="!store.runtimeReady" type="info" variant="tonal" density="compact" class="mb-4">
      {{ t('quick.runtimeNeeded') }}
      <template #append>
        <v-btn size="small" variant="text" :to="{ name: 'system' }">{{ t('nav.status') }}</v-btn>
      </template>
    </v-alert>

    <v-alert v-if="quick.error.value" type="error" density="compact" class="mb-4">
      {{ quick.error.value }}
    </v-alert>

    <!-- Setup, until a run starts -->
    <template v-if="quick.run.value === null">
      <v-card class="pa-5 mb-4">
        <h2 class="text-subtitle-1 font-weight-medium mb-3">{{ t('quick.filesTitle') }}</h2>
        <FileSourcePicker
          v-model:source="quick.source.value"
          v-model:server-files="quick.serverFiles.value"
          v-model:upload-files="quick.uploadFiles.value"
          :disabled="quick.busy.value"
        />
      </v-card>

      <v-card class="pa-5 mb-4">
        <h2 class="text-subtitle-1 font-weight-medium mb-3">{{ t('quick.outputTitle') }}</h2>

        <!-- Uploads come back as a download; there is no server folder the user could open. -->
        <FolderPickerField
          v-if="quick.source.value === 'server'"
          v-model="quick.outputPath.value"
          role="output"
          :must-exist="false"
          :label="t('quick.outputFolder')"
          :hint="t('quick.outputFolderHint')"
          :disabled="quick.busy.value"
          class="mb-4"
        />
        <v-alert v-else type="info" variant="tonal" density="compact" class="mb-4">
          {{ t('quick.downloadNotice') }}
        </v-alert>

        <div class="quick__formats">
          <v-chip
            v-for="format in FORMATS"
            :key="format.value"
            :color="quick.options.value.formats.includes(format.value) ? 'primary' : undefined"
            :variant="quick.options.value.formats.includes(format.value) ? 'flat' : 'outlined'"
            :disabled="quick.busy.value"
            label
            @click="toggleFormat(format.value)"
          >
            {{ t(format.labelKey) }}
          </v-chip>
        </div>

        <v-switch
          v-model="quick.options.value.tableRecognition"
          :label="t('module.table')"
          color="primary"
          density="compact"
          :disabled="quick.busy.value"
        />
        <v-switch
          v-model="quick.options.value.formulaRecognition"
          :label="t('module.formula')"
          color="primary"
          density="compact"
          :hint="t('quick.formulaHint')"
          persistent-hint
          :disabled="quick.busy.value"
        />
      </v-card>

      <v-progress-linear
        v-if="quick.busy.value && quick.source.value === 'upload'"
        :model-value="quick.uploadFraction.value * 100"
        height="6"
        rounded
        class="mb-3"
      />

      <v-btn
        color="primary"
        size="large"
        prepend-icon="play_arrow"
        :disabled="!quick.canStart.value"
        :loading="quick.busy.value"
        @click="quick.start"
      >
        {{ t('quick.start') }}
      </v-btn>
    </template>

    <!-- Progress, once it is going -->
    <v-card v-else class="pa-5">
      <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
        <h2 class="text-subtitle-1 font-weight-medium">
          {{ quick.isRunning.value ? t('quick.running') : t('quick.finished') }}
        </h2>
        <span class="text-body-2 text-medium-emphasis">
          {{
            t('quick.progressCount', {
              done: quick.succeeded.value + quick.failed.value,
              total: quick.run.value.fileCount,
            })
          }}
        </span>
      </div>

      <v-progress-linear
        :model-value="quick.completedFraction.value * 100"
        :indeterminate="quick.isRunning.value && quick.completedFraction.value === 0"
        height="8"
        rounded
        color="primary"
        class="mb-4"
      />

      <div class="d-flex ga-3 flex-wrap mb-4">
        <v-chip size="small" variant="tonal" color="succeeded" label>
          {{ t('quick.succeeded', { count: quick.succeeded.value }) }}
        </v-chip>
        <v-chip v-if="quick.failed.value > 0" size="small" variant="tonal" color="failed" label>
          {{ t('quick.failed', { count: quick.failed.value }) }}
        </v-chip>
      </div>

      <v-alert
        v-if="quick.isFinished.value && quick.run.value.outputPath !== null"
        type="success"
        variant="tonal"
        density="compact"
        class="mb-4"
      >
        {{ t('quick.writtenTo', { path: quick.run.value.outputPath }) }}
      </v-alert>

      <div class="d-flex ga-3 flex-wrap">
        <v-btn
          v-if="quick.isRunning.value"
          color="error"
          variant="tonal"
          prepend-icon="stop"
          :loading="quick.busy.value"
          @click="quick.cancel"
        >
          {{ t('quick.cancel') }}
        </v-btn>

        <v-btn
          v-if="quick.canDownload.value"
          color="primary"
          prepend-icon="download"
          :href="quick.downloadUrl.value"
          download
        >
          {{ t('quick.download') }}
        </v-btn>

        <v-btn v-if="quick.isFinished.value" variant="text" @click="quick.reset">
          {{ t('quick.newRun') }}
        </v-btn>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.quick__header {
  margin-bottom: 20px;
}

.quick__title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.quick__formats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
</style>
