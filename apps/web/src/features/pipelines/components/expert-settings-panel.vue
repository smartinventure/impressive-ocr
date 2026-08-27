<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AdvancedEngineOptions } from '@impressive-ocr/shared';
import InfoHint from '../../../components/info-hint.vue';

/**
 * The expert overrides, kept out of the editor for two reasons.
 *
 * The obvious one is size: `pipeline-editor-view.vue` is already past the SFC budget. The
 * other is that these fields behave unlike every other control on that screen — empty means
 * *unset*, not zero, and an unset field is omitted from the OCR call entirely rather than
 * sent as a default. Keeping that rule in one small component is what stops it leaking into
 * the thirty ordinary fields next door.
 */

const props = defineProps<{ modelValue: AdvancedEngineOptions }>();
const emit = defineEmits<{ 'update:modelValue': [AdvancedEngineOptions] }>();

const { t } = useI18n();

/** The numeric knobs. Keyed so the template can stay a loop rather than six near-copies. */
type NumericKey =
  | 'textDetLimitSideLen'
  | 'textDetBoxThresh'
  | 'textDetThresh'
  | 'textDetUnclipRatio'
  | 'textRecScoreThresh'
  | 'layoutThreshold';

/**
 * `paddleDefault` is shown in the hint, never written into the model.
 *
 * It is documentation of what PaddleOCR does when the field is blank — writing it in as a
 * value would pin today's default forever and defeat the point of leaving fields unset.
 */
const NUMERIC_FIELDS: {
  key: NumericKey;
  labelKey: string;
  hintKey: string;
  paddleDefault: string;
  min: number;
  max: number;
  step: number;
}[] = [
  {
    key: 'textRecScoreThresh',
    labelKey: 'expert.recScore',
    hintKey: 'expert.recScoreHint',
    paddleDefault: '0.0',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'textDetBoxThresh',
    labelKey: 'expert.detBox',
    hintKey: 'expert.detBoxHint',
    paddleDefault: '0.6',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'textDetThresh',
    labelKey: 'expert.detThresh',
    hintKey: 'expert.detThreshHint',
    paddleDefault: '0.3',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'textDetUnclipRatio',
    labelKey: 'expert.unclip',
    hintKey: 'expert.unclipHint',
    paddleDefault: '1.5',
    min: 0.5,
    max: 5,
    step: 0.1,
  },
  {
    key: 'textDetLimitSideLen',
    labelKey: 'expert.sideLen',
    hintKey: 'expert.sideLenHint',
    paddleDefault: '736',
    min: 320,
    max: 4096,
    step: 32,
  },
  {
    key: 'layoutThreshold',
    labelKey: 'expert.layoutThreshold',
    hintKey: 'expert.layoutThresholdHint',
    paddleDefault: '0.5',
    min: 0,
    max: 1,
    step: 0.05,
  },
];

/** Labels PP-StructureV3 assigns to blocks; the ones worth dropping from Markdown. */
const IGNORABLE_LABELS = ['header', 'footer', 'number', 'aside_text', 'seal', 'figure'];

const isModified = computed(() => Object.keys(props.modelValue).length > 0);

function setNumber(key: NumericKey, raw: unknown): void {
  const next = { ...props.modelValue };
  const text = typeof raw === 'string' ? raw.trim() : raw;

  // Cleared means "let PaddleOCR decide", which is a *deleted* key, not a zero. Writing 0
  // here would silently pin the most destructive value each of these fields can take.
  if (text === '' || text === null || text === undefined) {
    delete next[key];
    emit('update:modelValue', next);
    return;
  }

  const value = Number(text);
  if (!Number.isFinite(value)) {
    return;
  }
  next[key] = value;
  emit('update:modelValue', next);
}

function setLabels(raw: unknown): void {
  const next = { ...props.modelValue };
  const labels = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : [];
  if (labels.length === 0) {
    delete next.markdownIgnoreLabels;
  } else {
    next.markdownIgnoreLabels = labels;
  }
  emit('update:modelValue', next);
}

/** Back to "everything unset" — the state a new pipeline starts in. */
function resetAll(): void {
  emit('update:modelValue', {});
}
</script>

<template>
  <div class="expert">
    <v-alert type="info" variant="tonal" density="compact" class="mb-4">
      {{ t('expert.intro') }}
    </v-alert>

    <div class="expert__grid">
      <v-text-field
        v-for="field in NUMERIC_FIELDS"
        :key="field.key"
        :model-value="props.modelValue[field.key] ?? ''"
        type="number"
        :min="field.min"
        :max="field.max"
        :step="field.step"
        clearable
        density="comfortable"
        variant="outlined"
        :label="t(field.labelKey)"
        :placeholder="t('expert.unset', { value: field.paddleDefault })"
        persistent-placeholder
        :hint="t(field.hintKey)"
        persistent-hint
        @update:model-value="setNumber(field.key, $event)"
      />
    </div>

    <v-combobox
      :model-value="props.modelValue.markdownIgnoreLabels ?? []"
      :items="IGNORABLE_LABELS"
      multiple
      chips
      closable-chips
      clearable
      density="comfortable"
      variant="outlined"
      class="mt-4"
      :label="t('expert.ignoreLabels')"
      :hint="t('expert.ignoreLabelsHint')"
      persistent-hint
      @update:model-value="setLabels($event)"
    >
      <template #append><InfoHint topic="expertIgnoreLabels" /></template>
    </v-combobox>

    <v-btn
      variant="text"
      size="small"
      prepend-icon="restart_alt"
      class="mt-4"
      :disabled="!isModified"
      @click="resetAll"
    >
      {{ t('expert.reset') }}
    </v-btn>
  </div>
</template>

<style scoped>
.expert__grid {
  display: grid;
  /* Two across on a desktop, one on a narrow window. The German labels are long. */
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem 1.25rem;
}
</style>
