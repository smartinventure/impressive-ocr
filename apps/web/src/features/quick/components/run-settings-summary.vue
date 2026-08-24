<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { QuickOptions } from '@impressive-ocr/shared';

/**
 * What this run was asked to do, shown while it does it.
 *
 * Once a run starts, the form is replaced by the progress card and every choice that shaped
 * the result disappears from the screen. That matters most in exactly the case someone is
 * watching: comparing engines or devices on the same document, where the output is only
 * meaningful next to the settings that produced it.
 *
 * Deliberately the *requested* options rather than what the job reports. The device chip
 * beside this one already shows what actually ran, and the interesting question when the two
 * differ - "I asked for automatic and got CPU" - is only answerable if both are visible.
 */

const props = defineProps<{ options: QuickOptions }>();

const { t } = useI18n();

const ENGINE_LABELS = {
  fast: 'quick.engineFastShort',
  accurate: 'quick.engineAccurateShort',
} as const;

const DEVICE_LABELS = {
  auto: 'quick.deviceAuto',
  gpu: 'quick.deviceGpu',
  cpu: 'quick.deviceCpu',
} as const;

const STRATEGY_LABELS = {
  hybrid: 'quick.strategyHybridShort',
  'skip-if-text': 'quick.strategySkipShort',
  'always-ocr': 'quick.strategyAlwaysShort',
} as const;

/** Short names, because the picker's own labels are full sentences. */
const FORMAT_LABELS: Record<string, string> = {
  markdown: 'format.markdown',
  json: 'format.json',
  txt: 'format.txt',
  docx: 'format.docx',
  xlsx: 'format.xlsx',
  html: 'format.html',
  'searchable-pdf': 'format.searchablePdf',
  visualization: 'format.visualization',
};

const chips = computed(() => {
  const options = props.options;
  const entries: string[] = [
    t('quick.summaryEngine', { value: t(ENGINE_LABELS[options.profile]) }),
    t('quick.summaryDevice', { value: t(DEVICE_LABELS[options.device]) }),
    t('quick.summaryTextLayer', { value: t(STRATEGY_LABELS[options.textLayerStrategy]) }),
    t('quick.summaryFormats', {
      value: options.formats
        .map((format) => (FORMAT_LABELS[format] === undefined ? format : t(FORMAT_LABELS[format])))
        .join(', '),
    }),
  ];

  // Only when switched on. A chip saying a feature is off is noise on a card that is already
  // reporting four other things.
  if (options.tableRecognition) {
    entries.push(t('quick.summaryTables'));
  }
  if (options.formulaRecognition) {
    entries.push(t('quick.summaryFormulas'));
  }
  return entries;
});
</script>

<template>
  <div class="run-settings">
    <span class="run-settings__label text-body-2 text-medium-emphasis">
      {{ t('quick.settingsUsed') }}
    </span>
    <v-chip v-for="chip in chips" :key="chip" size="x-small" variant="outlined" label>
      {{ chip }}
    </v-chip>
  </div>
</template>

<style scoped>
.run-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.run-settings__label {
  /* Keeps the label with the first chip rather than orphaned on its own line. */
  margin-right: 0.25rem;
}
</style>
