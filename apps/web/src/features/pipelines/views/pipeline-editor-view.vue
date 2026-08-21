<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  draftPipelineOptions,
  formatVramGib,
  MIN_VRAM_GIB_FOR_VL,
  pipelineOptionsSchema,
  type OutputFormat,
  type PipelineOptions,
} from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { pipelinesApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import FolderPickerField from '../../../components/folder-picker-field.vue';

/**
 * The pipeline editor — around thirty settings across eight groups.
 *
 * Progressive disclosure by expansion panel: Source, Engine and Output are open by default
 * because they are what a new pipeline actually needs, and the rest have defaults that work.
 * Presenting all thirty at once is the difference between a form people fill in and one they
 * abandon.
 */

const props = defineProps<{ id?: string }>();

const router = useRouter();
const store = useLiveStore();
const { t } = useI18n();

const isEdit = computed(() => props.id !== undefined);
const name = ref('');
const description = ref('');
const options = ref<PipelineOptions>(blankOptions());
const saving = ref(false);
const formError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const openPanels = ref<string[]>(['source', 'engine', 'output']);

function blankOptions(): PipelineOptions {
  // Shared, so the form and the server start from exactly the same ~30 defaults with no
  // second copy to drift. It must not be `pipelineOptionsSchema.parse` with empty paths:
  // those are `.min(1)`, so that throws here in setup and renders a blank page.
  return draftPipelineOptions();
}

const FORMATS: { value: OutputFormat; labelKey: string; hintKey?: string }[] = [
  { value: 'markdown', labelKey: 'format.markdown' },
  { value: 'json', labelKey: 'format.json' },
  { value: 'txt', labelKey: 'format.txt' },
  { value: 'docx', labelKey: 'format.docx' },
  { value: 'xlsx', labelKey: 'format.xlsx', hintKey: 'format.xlsxHint' },
  { value: 'html', labelKey: 'format.html' },
  {
    value: 'searchable-pdf',
    labelKey: 'format.searchablePdf',
    hintKey: 'format.searchablePdfHint',
  },
];

/** Module toggles, with the speed cost stated inline — these turn 20 minutes into 3 hours. */
const MODULES = [
  { key: 'docOrientationClassify', labelKey: 'module.orientation', tone: 'neutral' },
  { key: 'docUnwarping', labelKey: 'module.unwarping', tone: 'slow' },
  { key: 'textlineOrientation', labelKey: 'module.textline', tone: 'neutral' },
  { key: 'tableRecognition', labelKey: 'module.table', tone: 'recommended' },
  { key: 'formulaRecognition', labelKey: 'module.formula', tone: 'slow' },
  { key: 'chartRecognition', labelKey: 'module.chart', tone: 'slow' },
  { key: 'sealRecognition', labelKey: 'module.seal', tone: 'slow' },
] as const;

const availableProfiles = computed(() => store.system?.hardware.availableProfiles ?? ['fast']);

const accurateUnavailable = computed(() => !availableProfiles.value.includes('accurate'));

/**
 * A working GPU that is merely too small for the VLM is a different message from no GPU at
 * all: those jobs still run on the GPU, and telling that user the machine "does not have a
 * compatible GPU" would be plainly wrong.
 */
const accurateUnavailableMessage = computed(() => {
  const hardware = store.system?.hardware;
  if (!hardware?.canUseGpu || hardware.gpu === null) {
    return t('editor.accurateUnavailable');
  }
  return t('editor.accurateNeedsVram', {
    required: MIN_VRAM_GIB_FOR_VL,
    vram: formatVramGib(hardware.gpu.vramBytes),
  });
});

function toggleFormat(format: OutputFormat): void {
  const current = options.value.output.formats;
  options.value.output.formats = current.includes(format)
    ? current.filter((item) => item !== format)
    : [...current, format];
}

async function save(): Promise<void> {
  saving.value = true;
  formError.value = null;
  fieldErrors.value = {};

  try {
    const body = { name: name.value, description: description.value, options: options.value };
    const saved = isEdit.value
      ? await pipelinesApi.update(props.id as string, body)
      : await pipelinesApi.create({ ...body, enabled: true });

    await store.refresh();
    await router.push({ name: 'pipeline-detail', params: { id: saved.id } });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      formError.value = error.message;
      // Attach the message to the offending input rather than only showing a banner the
      // user has to map back to a field themselves.
      const field = error.field;
      if (field !== null) {
        fieldErrors.value = { [field]: error.message };
      }
    } else {
      formError.value = t('errors.saveFailed');
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (props.id === undefined) {
    return;
  }
  try {
    const existing = store.pipelineById(props.id) ?? (await pipelinesApi.get(props.id));
    name.value = existing.name;
    description.value = existing.description;

    // safeParse, not parse: a pipeline stored by an older release can be missing a field
    // added since. Throwing here would leave the form silently empty with no explanation,
    // so fall back to the defaults and say so instead.
    const parsed = pipelineOptionsSchema.safeParse(existing.options);
    if (parsed.success) {
      options.value = parsed.data;
    } else {
      options.value = { ...draftPipelineOptions(), ...(existing.options as PipelineOptions) };
      formError.value = t('editor.optionsRecovered');
    }
  } catch (caught) {
    formError.value = caught instanceof ApiRequestError ? caught.message : t('editor.loadFailed');
  }
});
</script>

<template>
  <div class="editor">
    <header class="editor__header">
      <v-btn icon="arrow_back" variant="text" size="small" :to="{ name: 'pipelines' }" />
      <h1 class="editor__title">
        {{ isEdit ? t('editor.editTitle') : t('editor.newTitle') }}
      </h1>
    </header>

    <v-alert v-if="formError" type="error" density="compact" class="mb-4">
      {{ formError }}
    </v-alert>

    <v-form @submit.prevent="save">
      <v-card class="pa-5 mb-4">
        <v-text-field
          v-model="name"
          :label="t('editor.name')"
          :error-messages="fieldErrors.name"
          autofocus
          class="mb-4"
        />
        <v-textarea v-model="description" :label="t('editor.description')" rows="2" auto-grow />
      </v-card>

      <v-expansion-panels v-model="openPanels" multiple variant="accordion" class="editor__panels">
        <!-- Source -->
        <v-expansion-panel value="source">
          <v-expansion-panel-title>
            <v-icon icon="folder" size="20" class="mr-3" />
            {{ t('editor.sectionSource') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <FolderPickerField
              v-model="options.source.inputPath"
              role="input"
              :label="t('editor.inputFolder')"
              :hint="t('editor.inputFolderHint')"
              :external-error="fieldErrors['source.inputPath'] ?? null"
              class="mb-4"
            />
            <v-switch
              v-model="options.source.recursive"
              :label="t('editor.recursive')"
              color="primary"
              density="compact"
            />
            <v-switch
              v-model="options.source.mirrorFolderStructure"
              :label="t('editor.mirror')"
              color="primary"
              density="compact"
            />
            <v-switch
              v-model="options.source.skipDuplicates"
              :label="t('editor.skipDuplicates')"
              color="primary"
              density="compact"
            />
            <v-select
              v-model="options.source.watchMode"
              :items="[
                { value: 'events', title: t('editor.watchEvents') },
                { value: 'polling', title: t('editor.watchPolling') },
              ]"
              :label="t('editor.watchMode')"
              :hint="t('editor.watchModeHint')"
              persistent-hint
              class="mt-4"
            />
          </v-expansion-panel-text>
        </v-expansion-panel>

        <!-- Engine -->
        <v-expansion-panel value="engine">
          <v-expansion-panel-title>
            <v-icon icon="tune" size="20" class="mr-3" />
            {{ t('editor.sectionEngine') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-alert v-if="accurateUnavailable" type="info" density="compact" class="mb-4">
              {{ accurateUnavailableMessage }}
            </v-alert>

            <v-select
              v-model="options.engine.profile"
              :items="[
                { value: 'fast', title: t('profile.fast'), subtitle: t('editor.fastHint') },
                {
                  value: 'accurate',
                  title: t('profile.accurate'),
                  subtitle: t('editor.accurateHint'),
                  props: { disabled: accurateUnavailable },
                },
              ]"
              :label="t('editor.profile')"
              class="mb-4"
            />

            <v-select
              v-model="options.engine.device"
              :items="[
                { value: 'auto', title: t('device.auto') },
                { value: 'gpu', title: t('device.gpu') },
                { value: 'cpu', title: t('device.cpu') },
              ]"
              :label="t('editor.device')"
              class="mb-4"
            />

            <v-select
              v-model="options.engine.rasterDpi"
              :items="[150, 200, 300, 400]"
              :label="t('editor.dpi')"
              :hint="t('editor.dpiHint')"
              persistent-hint
              class="mb-4"
            />

            <v-select
              v-model="options.textLayerStrategy"
              :items="[
                { value: 'hybrid', title: t('editor.textHybrid') },
                { value: 'skip-if-text', title: t('editor.textSkip') },
                { value: 'always-ocr', title: t('editor.textAlways') },
              ]"
              :label="t('editor.textLayer')"
              :hint="t('editor.textLayerHint')"
              persistent-hint
              class="mb-5"
            />

            <div class="editor__modules-title">{{ t('editor.modules') }}</div>
            <div v-for="module in MODULES" :key="module.key" class="editor__module">
              <v-switch
                v-model="options.engine.modules[module.key]"
                :label="t(module.labelKey)"
                color="primary"
                density="compact"
                hide-details
              />
              <span class="editor__module-tone" :class="`editor__module-tone--${module.tone}`">
                {{ t(`moduleTone.${module.tone}`) }}
              </span>
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>

        <!-- Output -->
        <v-expansion-panel value="output">
          <v-expansion-panel-title>
            <v-icon icon="description" size="20" class="mr-3" />
            {{ t('editor.sectionOutput') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <FolderPickerField
              v-model="options.output.outputPath"
              role="output"
              :label="t('editor.outputFolder')"
              :hint="t('editor.outputFolderHint')"
              :must-exist="false"
              :external-error="fieldErrors['output.outputPath'] ?? null"
              class="mb-4"
            />

            <div class="editor__modules-title">{{ t('editor.formats') }}</div>
            <div class="editor__formats">
              <v-chip
                v-for="format in FORMATS"
                :key="format.value"
                :variant="options.output.formats.includes(format.value) ? 'flat' : 'outlined'"
                :color="options.output.formats.includes(format.value) ? 'primary' : undefined"
                filter
                :model-value="options.output.formats.includes(format.value)"
                @click="toggleFormat(format.value)"
              >
                {{ t(format.labelKey) }}
                <span v-if="format.hintKey" class="editor__format-hint">
                  {{ t(format.hintKey) }}
                </span>
              </v-chip>
            </div>

            <v-text-field
              v-model="options.output.namingTemplate"
              :label="t('editor.namingTemplate')"
              :hint="t('editor.namingTemplateHint')"
              persistent-hint
              class="mt-4"
            />

            <v-select
              v-model="options.output.collisionPolicy"
              :items="[
                { value: 'suffix', title: t('editor.collisionSuffix') },
                { value: 'overwrite', title: t('editor.collisionOverwrite') },
                { value: 'skip', title: t('editor.collisionSkip') },
              ]"
              :label="t('editor.collision')"
              class="mt-4"
            />
          </v-expansion-panel-text>
        </v-expansion-panel>

        <!-- After success -->
        <v-expansion-panel value="post">
          <v-expansion-panel-title>
            <v-icon icon="done_all" size="20" class="mr-3" />
            {{ t('editor.sectionAfter') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-select
              v-model="options.postProcessing.onSuccess"
              :items="[
                { value: 'keep', title: t('editor.keepSource') },
                { value: 'delete', title: t('editor.deleteSource') },
                { value: 'move-to-output', title: t('editor.moveToOutput') },
                { value: 'move-to-archive', title: t('editor.moveToArchive') },
              ]"
              :label="t('editor.onSuccess')"
              class="mb-4"
            />
            <FolderPickerField
              v-if="options.postProcessing.onSuccess === 'move-to-archive'"
              v-model="options.postProcessing.archivePath as string"
              role="output"
              :label="t('editor.archiveFolder')"
              :must-exist="false"
              :external-error="fieldErrors['postProcessing.archivePath'] ?? null"
            />
          </v-expansion-panel-text>
        </v-expansion-panel>

        <!-- Reliability -->
        <v-expansion-panel value="reliability">
          <v-expansion-panel-title>
            <v-icon icon="shield" size="20" class="mr-3" />
            {{ t('editor.sectionReliability') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-text-field
              v-model.number="options.reliability.maxAttempts"
              type="number"
              :label="t('editor.maxAttempts')"
              class="mb-4"
            />
            <v-text-field
              v-model.number="options.reliability.concurrency"
              type="number"
              :label="t('editor.concurrency')"
              class="mb-4"
            />
            <FolderPickerField
              v-model="options.reliability.quarantinePath as string"
              role="output"
              :label="t('editor.quarantineFolder')"
              :hint="t('editor.quarantineHint')"
              :must-exist="false"
              :external-error="fieldErrors['reliability.quarantinePath'] ?? null"
            />
          </v-expansion-panel-text>
        </v-expansion-panel>

        <!-- Schedule -->
        <v-expansion-panel value="schedule">
          <v-expansion-panel-title>
            <v-icon icon="schedule" size="20" class="mr-3" />
            {{ t('editor.sectionSchedule') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-slider
              v-model="options.schedule.priority"
              :min="0"
              :max="9"
              :step="1"
              thumb-label
              :label="t('editor.priority')"
              class="mb-2"
            />
            <v-switch
              v-model="options.schedule.activeHoursEnabled"
              :label="t('editor.activeHours')"
              color="primary"
              density="compact"
            />
            <div v-if="options.schedule.activeHoursEnabled" class="d-flex ga-3 mt-2">
              <v-text-field
                v-model="options.schedule.activeFrom"
                :label="t('editor.activeFrom')"
                type="time"
              />
              <v-text-field
                v-model="options.schedule.activeUntil"
                :label="t('editor.activeUntil')"
                type="time"
              />
            </div>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <div class="editor__actions">
        <v-btn variant="text" :to="{ name: 'pipelines' }">{{ t('common.cancel') }}</v-btn>
        <v-btn type="submit" color="primary" :loading="saving">{{ t('common.save') }}</v-btn>
      </div>
    </v-form>
  </div>
</template>

<style scoped>
.editor {
  max-width: 860px;
}

.editor__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.editor__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 26px;
  font-weight: 500;
  margin: 0;
}

.editor__panels {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 12px;
  overflow: hidden;
}

.editor__modules-title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
}

.editor__module {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.editor__module-tone {
  font-size: 12px;
  white-space: nowrap;
}

.editor__module-tone--slow {
  color: rgb(var(--v-theme-paused));
}

.editor__module-tone--recommended {
  color: rgb(var(--v-theme-succeeded));
}

.editor__module-tone--neutral {
  color: var(--ocr-on-surface-muted);
}

.editor__formats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.editor__format-hint {
  font-size: 11px;
  opacity: 0.7;
  margin-left: 6px;
}

.editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}
</style>
