<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  draftPipelineOptions,
  formatVramGib,
  MIN_VRAM_GIB_FOR_VL,
  pipelineOptionsSchema,
  recommendedProfile,
  type OutputFormat,
  type PipelineOptions,
} from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { pipelinesApi } from '../../../api/endpoints';
import { useLiveStore } from '../../../stores/live-store';
import FolderPickerField from '../../../components/folder-picker-field.vue';
import ExpertSettingsPanel from '../components/expert-settings-panel.vue';
import InfoHint from '../../../components/info-hint.vue';

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

/**
 * Whether the rendering resolution and the module switches do anything on this engine.
 *
 * Both belong to PP-StructureV3. The accurate engine is handed the PDF and derives its own
 * page geometry — rendering it to an image first costs reading order rather than gaining
 * anything — and it reads layout, tables and formulas in one pass, so the module toggles are
 * never sent. Showing settings that are quietly ignored is worse than not offering them: it
 * invites tuning a run by a control that was never connected to it.
 */
const structureSettingsApply = computed(() => options.value.engine.profile === 'fast');

/**
 * The toggles worth showing for the selected engine.
 *
 * The two engines have almost opposite needs here. The accurate engine does layout, tables
 * and formulas in one pass, so those switches have nothing to act on. The fast engine has
 * them all — except chart data, which it no longer offers at all: its chart-to-table model
 * reads bar heights against a scale it invents, and the sidecar stopped loading it.
 *
 * So the chart switch is the one option that belongs to the accurate engine alone, and every
 * other option belongs to the fast one. Reading a chart's *text* is not in this list, because
 * it is not optional and happens on both.
 */
const visibleModules = computed(() =>
  structureSettingsApply.value
    ? MODULES.filter((module) => module.key !== 'chartRecognition')
    : MODULES.filter((module) => module.key === 'chartRecognition'),
);
const name = ref('');
const description = ref('');
const options = ref<PipelineOptions>(blankOptions());
const saving = ref(false);
const formError = ref<string | null>(null);
const fieldErrors = ref<Record<string, string>>({});
const openPanels = ref<string[]>(['source', 'engine', 'output']);

/**
 * Re-apply the recommended profile once the hardware probe arrives.
 *
 * `blankOptions()` runs during setup, usually before the probe has landed, so without this
 * a new pipeline on a capable machine would still open on `fast`. Restricted to a new,
 * untouched form: an existing pipeline's profile is a saved decision, and changing what a
 * watched folder does without being asked is not an improvement.
 */
const profileChosen = ref(false);
watch(
  () => store.system?.hardware.availableProfiles,
  (profiles) => {
    if (profiles === undefined || profileChosen.value || isEdit.value) return;
    options.value.engine.profile = recommendedProfile(profiles);
  },
);

function blankOptions(): PipelineOptions {
  // Shared, so the form and the server start from exactly the same ~30 defaults with no
  // second copy to drift. It must not be `pipelineOptionsSchema.parse` with empty paths:
  // those are `.min(1)`, so that throws here in setup and renders a blank page.
  const draft = draftPipelineOptions();
  const profiles = store.system?.hardware.availableProfiles;

  // A new pipeline starts on the better profile where the machine has one. Only a new one:
  // an existing pipeline's saved choice is the user's, and silently upgrading it would
  // change what a watched folder does without anyone asking for it.
  return profiles === undefined
    ? draft
    : { ...draft, engine: { ...draft.engine, profile: recommendedProfile(profiles) } };
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
  {
    value: 'visualization',
    labelKey: 'format.visualization',
    hintKey: 'format.visualizationHint',
  },
];

/**
 * Module toggles, with the speed cost stated inline — these turn 20 minutes into 3 hours.
 *
 * `hintKey` is for the switches whose name does not say what they decide. "Recognize charts"
 * sounds like it controls whether a chart's text is read; it does not, and has not since the
 * sidecar started recovering that text from the page-wide OCR pass. What it actually buys is
 * an attempt to reconstruct the plotted *values* as a table, which costs a separate model and
 * most of a minute per chart -- a very different trade from the one the label implies.
 */
const MODULES = [
  { key: 'docOrientationClassify', labelKey: 'module.orientation', tone: 'neutral' },
  { key: 'docUnwarping', labelKey: 'module.unwarping', tone: 'slow' },
  { key: 'textlineOrientation', labelKey: 'module.textline', tone: 'neutral' },
  { key: 'tableRecognition', labelKey: 'module.table', tone: 'recommended' },
  { key: 'formulaRecognition', labelKey: 'module.formula', tone: 'slow' },
  { key: 'chartRecognition', labelKey: 'module.chart', tone: 'slow', hintKey: 'module.chartHint' },
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

/**
 * The one selected format, when there is only one.
 *
 * Its chip is disabled rather than merely inert: a click that silently does nothing reads as
 * a broken control, while a disabled chip says "this is the last one" without a sentence of
 * explanation.
 */
function isLastSelectedFormat(format: OutputFormat): boolean {
  const current = options.value.output.formats;
  return current.length === 1 && current[0] === format;
}

function toggleFormat(format: OutputFormat): void {
  const current = options.value.output.formats;
  if (!current.includes(format)) {
    options.value.output.formats = [...current, format];
    return;
  }
  // Guarded as well as disabled. `formats` is `.min(1)` in the schema, so emptying it would
  // fail validation only on save — after the user had filled in the whole form.
  if (current.length === 1) {
    return;
  }
  options.value.output.formats = current.filter((item) => item !== format);
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
              help-topic="editorInputFolder"
              :external-error="fieldErrors['source.inputPath'] ?? null"
              class="mb-4"
            />
            <v-switch
              v-model="options.source.recursive"
              :label="t('editor.recursive')"
              color="primary"
              density="compact"
            >
              <template #append><InfoHint topic="editorRecursive" /></template>
            </v-switch>
            <v-switch
              v-model="options.source.mirrorFolderStructure"
              :label="t('editor.mirror')"
              color="primary"
              density="compact"
            >
              <template #append><InfoHint topic="editorMirror" /></template>
            </v-switch>
            <v-switch
              v-model="options.source.skipDuplicates"
              :label="t('editor.skipDuplicates')"
              color="primary"
              density="compact"
            >
              <template #append><InfoHint topic="editorSkipDuplicates" /></template>
            </v-switch>
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
            >
              <template #append><InfoHint topic="editorWatchMode" /></template>
            </v-select>
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
              @update:model-value="profileChosen = true"
            >
              <template #append><InfoHint topic="editorProfile" /></template>
            </v-select>

            <v-select
              v-model="options.engine.device"
              :items="[
                { value: 'auto', title: t('device.auto') },
                { value: 'gpu', title: t('device.gpu') },
                { value: 'cpu', title: t('device.cpu') },
              ]"
              :label="t('editor.device')"
              class="mb-4"
            >
              <template #append><InfoHint topic="editorDevice" /></template>
            </v-select>

            <v-select
              v-if="structureSettingsApply"
              v-model="options.engine.rasterDpi"
              :items="[150, 200, 300, 400]"
              :label="t('editor.dpi')"
              :hint="t('editor.dpiHint')"
              persistent-hint
              class="mb-4"
            >
              <template #append><InfoHint topic="editorDpi" /></template>
            </v-select>

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
            >
              <template #append><InfoHint topic="editorTextLayer" /></template>
            </v-select>

            <template v-if="visibleModules.length > 0">
              <div class="editor__modules-title">
                {{ t('editor.modules') }}
                <InfoHint topic="editorModules" />
              </div>
              <p v-if="!structureSettingsApply" class="text-body-2 text-medium-emphasis mb-2">
                {{ t('editor.modulesBuiltIn') }}
              </p>
              <div v-for="module in visibleModules" :key="module.key" class="editor__module-row">
                <div class="editor__module">
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
                <p v-if="'hintKey' in module" class="editor__module-hint">
                  {{ t(module.hintKey) }}
                </p>
              </div>
            </template>


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
              help-topic="editorOutputFolder"
              :must-exist="false"
              :external-error="fieldErrors['output.outputPath'] ?? null"
              class="mb-4"
            />

            <div class="editor__modules-title">
              {{ t('editor.formats') }}
              <InfoHint topic="editorFormats" />
            </div>
            <div class="editor__formats">
              <!-- No `model-value` here, deliberately. On VChip that prop is the chip's own
                   visibility: `isActive.value && createVNode(...)`, so binding it to "is this
                   format selected" made every *unselected* format render nothing. Only the two
                   defaults were ever visible, and because a hidden chip cannot be clicked, a
                   format could be removed from a pipeline but never added back. Selection is
                   shown by variant and colour instead, as Quick Mode already does. -->
              <v-chip
                v-for="format in FORMATS"
                :key="format.value"
                :variant="options.output.formats.includes(format.value) ? 'flat' : 'outlined'"
                :color="options.output.formats.includes(format.value) ? 'primary' : undefined"
                :disabled="isLastSelectedFormat(format.value)"
                label
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
            >
              <template #append><InfoHint topic="editorNamingTemplate" /></template>
            </v-text-field>

            <v-select
              v-model="options.output.collisionPolicy"
              :items="[
                { value: 'suffix', title: t('editor.collisionSuffix') },
                { value: 'overwrite', title: t('editor.collisionOverwrite') },
                { value: 'skip', title: t('editor.collisionSkip') },
              ]"
              :label="t('editor.collision')"
              class="mt-4"
            >
              <template #append><InfoHint topic="editorCollision" /></template>
            </v-select>

            <!-- Only meaningful when a .txt is actually being written; no other writer reads
                 it. Shown unconditionally it would be a setting that silently does nothing. -->
            <v-select
              v-if="options.output.formats.includes('txt')"
              v-model="options.output.txtEncoding"
              :items="[
                { value: 'utf-8', title: t('editor.encodingUtf8') },
                { value: 'utf-8-bom', title: t('editor.encodingUtf8Bom') },
                { value: 'latin-1', title: t('editor.encodingLatin1') },
              ]"
              :label="t('editor.encoding')"
              :hint="t('editor.encodingHint')"
              persistent-hint
              class="mt-4"
            >
              <template #append><InfoHint topic="editorEncoding" /></template>
            </v-select>
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
            >
              <template #append><InfoHint topic="editorOnSuccess" /></template>
            </v-select>
            <FolderPickerField
              v-if="options.postProcessing.onSuccess === 'move-to-archive'"
              v-model="options.postProcessing.archivePath as string"
              role="output"
              :label="t('editor.archiveFolder')"
              help-topic="editorArchiveFolder"
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
            >
              <template #append><InfoHint topic="editorMaxAttempts" /></template>
            </v-text-field>
            <v-text-field
              v-model.number="options.reliability.concurrency"
              type="number"
              :label="t('editor.concurrency')"
              class="mb-4"
            >
              <template #append><InfoHint topic="editorConcurrency" /></template>
            </v-text-field>
            <FolderPickerField
              v-model="options.reliability.quarantinePath as string"
              role="output"
              :label="t('editor.quarantineFolder')"
              :hint="t('editor.quarantineHint')"
              help-topic="editorQuarantineFolder"
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
            >
              <template #append>
                <span class="editor__slider-value ocr-mono">{{ options.schedule.priority }}</span>
                <InfoHint topic="editorPriority" />
              </template>
            </v-slider>
            <v-switch
              v-model="options.schedule.activeHoursEnabled"
              :label="t('editor.activeHours')"
              color="primary"
              density="compact"
            >
              <template #append><InfoHint topic="editorActiveHours" /></template>
            </v-switch>
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

        <!-- Last, and closed unless someone deliberately opens it. Every field here is a
             footgun: a nudged threshold produces a quality complaint weeks later with no
             obvious cause, so it is kept away from the settings people are meant to touch. -->
        <v-expansion-panel value="expert">
          <v-expansion-panel-title>
            <v-icon icon="tune" size="20" class="mr-3" />
            {{ t('editor.sectionExpert') }}
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <expert-settings-panel v-model="options.engine.advanced" />
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
/* Same reason as the settings sliders: a value that only appears while dragging tells you
   nothing about a form you are reading. */
.editor__slider-value {
  min-width: 1.5rem;
  text-align: right;
  font-size: 0.875rem;
  opacity: 0.75;
}

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

.editor__module-row {
  display: flex;
  flex-direction: column;
}

/* Aligned under the switch label rather than the switch itself, which is where the eye goes
   looking for the sentence that explains it. */
.editor__module-hint {
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.7;
  margin: -4px 0 8px 52px;
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
