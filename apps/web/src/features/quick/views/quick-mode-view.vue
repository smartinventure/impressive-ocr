<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OutputFormat, QuickRunFile } from '@impressive-ocr/shared';
import { useLiveStore } from '../../../stores/live-store';
import { useQuickRun } from '../composables/use-quick-run';
import FileSourcePicker from '../components/file-source-picker.vue';
import FolderPickerField from '../../../components/folder-picker-field.vue';
import RunSettingsSummary from '../components/run-settings-summary.vue';
import EngineHelp from '../components/engine-help.vue';
import InfoHint from '../../../components/info-hint.vue';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';

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

const desktop = useDesktopBridge();

/** Whatever went wrong with the last open, shown under the list rather than in a dialog. */
const openError = ref<string | null>(null);

/**
 * How many results to show before folding the rest away.
 *
 * A ten-document run in four formats is forty rows, and this list has no height cap — it
 * pushes everything below it off the screen, including the button to start another run.
 */
const VISIBLE_FILES = 5;

const showAllFiles = ref(false);

const visibleFiles = computed(() =>
  showAllFiles.value ? quick.files.value : quick.files.value.slice(0, VISIBLE_FILES),
);

const hiddenFileCount = computed(() => Math.max(0, quick.files.value.length - VISIBLE_FILES));

/**
 * Whether the rows should open files instead of downloading them.
 *
 * Both conditions matter. Without the bridge there is no way to open anything — the same page
 * runs in a plain browser against a headless server, possibly on another machine. Without an
 * output folder the results live in the server's working directory, which is swept on a
 * retention window and is not the user's to open.
 */
const canOpenFiles = computed(
  () => desktop.isDesktop.value && (quick.run.value?.outputPath ?? null) !== null,
);

async function openFile(file: QuickRunFile): Promise<void> {
  openError.value = null;
  const path = quick.filePath(file);
  if (path === null) return;

  const result = await desktop.bridge.value?.openFile(path);
  if (result === undefined || result.status === 'opened') return;

  // The refusals are worth different sentences. A swept result is routine and the user just
  // needs to know it is gone; a type we decline to launch is a deliberate limit.
  openError.value =
    result.reason === 'missing'
      ? t('quick.openMissing', { name: file.fileName })
      : t('quick.openRefused', { name: file.fileName });
}

async function revealFile(file: QuickRunFile): Promise<void> {
  const path = quick.filePath(file);
  if (path !== null) await desktop.bridge.value?.showInFolder(path);
}

/** The formats worth offering without a pipeline. The editor exposes the rest. */
/** Offering GPU on a machine that cannot use one would only produce a silent fallback. */
/**
 * Result files run from a few kilobytes of Markdown to a searchable PDF of many megabytes, so
 * the unit has to follow the number rather than being fixed at GB like the hardware readouts.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const gpuAvailable = computed(() => store.system?.hardware.canUseGpu ?? false);

/**
 * Whether the per-module switches mean anything for the selected engine.
 *
 * They are PP-StructureV3's, and the accurate engine is a vision-language model that reads
 * layout, tables and formulas in one pass — `build_predict_kwargs` in the sidecar does not
 * send them to it at all. Left on screen they invite exactly the wrong conclusion: that a
 * page of mathematics came out well *because* formula recognition was on, or badly because
 * it was off, when neither switch was ever consulted.
 */
const modulesApply = computed(() => quick.options.value.profile === 'fast');

/**
 * Whether the vision-language engine can run here at all.
 *
 * It no longer needs a graphics card — the inference engine runs it on a processor at about
 * 11 s a page — but it does need that engine installed, so this stays false until it is,
 * rather than offering a profile that would be refused.
 */
const accurateAvailable = computed(
  () => store.system?.hardware.availableProfiles.includes('accurate') ?? false,
);

const FORMATS: { value: OutputFormat; labelKey: string }[] = [
  { value: 'markdown', labelKey: 'format.markdown' },
  { value: 'json', labelKey: 'format.json' },
  { value: 'txt', labelKey: 'format.txt' },
  { value: 'docx', labelKey: 'format.docx' },
  { value: 'xlsx', labelKey: 'format.xlsx' },
  { value: 'searchable-pdf', labelKey: 'format.searchablePdf' },
];

/** The sole selected format, if only one is left. Its chip is disabled rather than inert. */
function isLastSelectedFormat(format: OutputFormat): boolean {
  const current = quick.options.value.formats;
  return current.length === 1 && current[0] === format;
}

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
        <h2 class="text-subtitle-1 font-weight-medium mb-3">
          {{ t('quick.filesTitle') }}
          <InfoHint topic="quickSource" />
        </h2>
        <FileSourcePicker
          v-model:source="quick.source.value"
          v-model:server-files="quick.serverFiles.value"
          v-model:upload-files="quick.uploadFiles.value"
          v-model:server-folders="quick.serverFolders.value"
          v-model:folder-extensions="quick.folderExtensions.value"
          v-model:folder-file-count="quick.folderFileCount.value"
          :disabled="quick.busy.value"
        />
      </v-card>

      <v-card class="pa-5 mb-4">
        <h2 class="text-subtitle-1 font-weight-medium mb-3">
          {{ t('quick.outputTitle') }}
        </h2>

        <!-- Uploads come back as a download; there is no server folder the user could open. -->
        <FolderPickerField
          v-if="quick.source.value === 'server'"
          v-model="quick.outputPath.value"
          role="output"
          :must-exist="false"
          :label="t('quick.outputFolder')"
          :hint="t('quick.outputFolderHint')"
          :disabled="quick.busy.value"
          help-topic="quickOutputFolder"
          class="mb-4"
        />
        <v-alert v-else type="info" variant="tonal" density="compact" class="mb-4">
          {{ t('quick.downloadNotice') }}
        </v-alert>

        <div class="quick__formats-label">
          {{ t('editor.formats') }}
          <InfoHint topic="quickFormats" />
        </div>
        <div class="quick__formats">
          <v-chip
            v-for="format in FORMATS"
            :key="format.value"
            :color="quick.options.value.formats.includes(format.value) ? 'primary' : undefined"
            :variant="quick.options.value.formats.includes(format.value) ? 'flat' : 'outlined'"
            :disabled="quick.busy.value || isLastSelectedFormat(format.value)"
            label
            @click="toggleFormat(format.value)"
          >
            {{ t(format.labelKey) }}
          </v-chip>
        </div>

        <!-- Quick Mode is where someone converts one document and wants it right, which is
             exactly the case the slower engine is for. It defaulted to `fast` with no way to
             change it, so the better recogniser was unreachable outside a pipeline. -->
        <v-select
          v-model="quick.options.value.profile"
          :items="[
            { value: 'fast', title: t('quick.profileFast') },
            {
              value: 'accurate',
              title: t('quick.profileAccurate'),
              props: { disabled: !accurateAvailable },
            },
          ]"
          :label="t('quick.profileLabel')"
          :hint="accurateAvailable ? t('quick.profileHint') : t('quick.profileHintNoGpu')"
          persistent-hint
          density="comfortable"
          variant="outlined"
          class="mb-4"
          :disabled="quick.busy.value"
          @update:model-value="quick.keepProfile"
        >
          <template #append><InfoHint topic="quickProfile" /></template>
        </v-select>

        <!-- The two engines fail differently, not merely at different speeds, and the
             consequence of choosing wrong is a batch reprocessed. Explained next to the
             choice rather than in documentation nobody opens mid-task. -->
        <div class="mb-4 mt-n2">
          <EngineHelp />
        </div>

        <!-- Forcing one device or the other is how you find out what the GPU is worth on your
             own documents; `auto` leaves the choice to the scheduler. -->
        <v-select
          v-model="quick.options.value.device"
          :items="[
            { value: 'auto', title: t('quick.deviceAuto') },
            { value: 'gpu', title: t('quick.deviceGpu'), props: { disabled: !gpuAvailable } },
            { value: 'cpu', title: t('quick.deviceCpu') },
          ]"
          :label="t('quick.deviceLabel')"
          :hint="gpuAvailable ? t('quick.deviceHint') : t('quick.deviceHintNoGpu')"
          persistent-hint
          density="comfortable"
          variant="outlined"
          class="mb-4"
          :disabled="quick.busy.value"
        >
          <template #append><InfoHint topic="quickDevice" /></template>
        </v-select>

        <v-select
          v-model="quick.options.value.textLayerStrategy"
          :items="[
            { value: 'hybrid', title: t('quick.strategyHybrid') },
            { value: 'skip-if-text', title: t('quick.strategySkip') },
            { value: 'always-ocr', title: t('quick.strategyAlways') },
          ]"
          :label="t('quick.strategy')"
          :hint="t('quick.strategyHint')"
          persistent-hint
          density="comfortable"
          variant="outlined"
          class="mb-4"
          :disabled="quick.busy.value"
        >
          <template #append><InfoHint topic="quickTextLayer" /></template>
        </v-select>

        <template v-if="modulesApply">
          <v-switch
            v-model="quick.options.value.tableRecognition"
            :label="t('module.table')"
            color="primary"
            density="compact"
            :hint="t('quick.tableCost')"
            persistent-hint
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
        </template>

        <p v-else class="text-body-2 text-medium-emphasis mb-0">
          {{ t('quick.modulesBuiltIn') }}
        </p>
      </v-card>

      <!-- Sending a large scan over a slow link is minutes, and a bare disabled button for
           the duration is indistinguishable from a frozen page. Labelled with a percentage
           while there are bytes to count, and indeterminate afterwards, because waiting for
           the server to accept the run has no percentage to report honestly. -->
      <v-card v-if="quick.phase.value !== 'idle'" variant="tonal" class="pa-4 mb-3">
        <div class="d-flex align-center justify-space-between ga-3 mb-2">
          <span class="text-body-2">
            {{
              quick.phase.value === 'uploading'
                ? t('quick.uploading', { count: quick.fileCount.value })
                : t('quick.startingRun')
            }}
          </span>
          <span v-if="quick.phase.value === 'uploading'" class="text-caption ocr-mono">
            {{ Math.round(quick.uploadFraction.value * 100) }}%
          </span>
        </div>
        <v-progress-linear
          :model-value="quick.uploadFraction.value * 100"
          :indeterminate="quick.phase.value === 'starting'"
          height="6"
          rounded
          color="primary"
        />
      </v-card>

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

      <!-- Page-level movement, so a single long scan does not look stuck. -->
      <p v-if="quick.currentDocument.value" class="text-body-2 text-medium-emphasis mb-1">
        {{ quick.currentDocument.value.name }}
        <template v-if="quick.currentDocument.value.pageCount">
          &middot;
          {{
            t('quick.pageProgress', {
              done: quick.currentDocument.value.pagesDone,
              total: quick.currentDocument.value.pageCount,
            })
          }}
        </template>
      </p>

      <!-- What the worker is doing right now. Loading the models is most of the first
           document's wall clock and moves no counter, so without this the card shows
           "0 of 1" and nothing else for the better part of a minute. -->
      <p
        v-if="quick.isRunning.value || quick.statusMessage.value"
        class="quick__status text-body-2 mb-3"
      >
        <v-progress-circular
          v-if="quick.isRunning.value"
          indeterminate
          size="12"
          width="2"
          class="mr-2"
        />
        <!-- The worker loads its models before it accepts the job, so the first seconds
             belong to no job and produce no events. Saying so beats an empty line. -->
        {{ quick.statusMessage.value ?? t('quick.startingWorker') }}
      </p>

      <div class="d-flex ga-3 flex-wrap mb-4">
        <v-chip size="small" variant="tonal" color="succeeded" label>
          {{ t('quick.succeeded', { count: quick.succeeded.value }) }}
        </v-chip>
        <v-chip v-if="quick.failed.value > 0" size="small" variant="tonal" color="failed" label>
          {{ t('quick.failed', { count: quick.failed.value }) }}
        </v-chip>
        <!-- Which engine actually ran it, reported by the job rather than assumed. -->
        <v-chip v-if="quick.device.value" size="small" variant="tonal" label>
          {{ t('quick.device', { device: quick.device.value.toUpperCase() }) }}
        </v-chip>
        <v-chip v-if="quick.pageProgress.value.total > 0" size="small" variant="tonal" label>
          {{
            t('quick.pagesTotal', {
              done: quick.pageProgress.value.done,
              total: quick.pageProgress.value.total,
            })
          }}
        </v-chip>
      </div>

      <!-- The form is gone once a run starts, taking every choice that shaped the result with
           it. Shown after the counters so the live numbers stay first. -->
      <RunSettingsSummary :options="quick.options.value" class="mb-4" />

      <!-- Say why, rather than leaving a zero to be interpreted. -->
      <v-alert
        v-if="quick.failed.value > 0 && quick.failureMessage.value"
        type="error"
        variant="tonal"
        density="compact"
        class="mb-4"
      >
        {{ quick.failureMessage.value }}
      </v-alert>

      <!-- A format that could not be written does not fail the job, so without this a run
           that produced no Word document looks identical to one that did. -->
      <v-alert
        v-if="quick.problems.value.length > 0"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-4"
      >
        <p class="mb-1">{{ t('quick.partialTitle') }}</p>
        <ul class="quick__problems">
          <li v-for="problem in quick.problems.value" :key="problem.id">{{ problem.message }}</li>
        </ul>
      </v-alert>

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

        <!-- Outlined, to match the source toggle above: a bare text button reads as a hint
             rather than the thing you press to start over. -->
        <v-btn v-if="quick.isFinished.value" variant="outlined" @click="quick.reset">
          {{ t('quick.newRun') }}
        </v-btn>
      </div>

      <!-- Each result on its own, beside the ZIP.
           A ten-document run in four formats is forty files, and someone who came for the
           Markdown of one of them should not have to take the other thirty-nine.

           Two different lists, because the files are in two different places. An upload run
           produced them on the server, so each row is a download. A folder run wrote them to
           a directory the user picked, and in the desktop app they can simply be opened —
           downloading a second copy of a file already sitting on your own disk is not a
           feature. In a browser against a headless server that is not possible, and the
           written-to path above is all we can honestly offer. -->
      <div v-if="quick.files.value.length > 0" class="quick__files mt-5">
        <div class="text-subtitle-2 mb-2">
          {{ canOpenFiles ? t('quick.openFiles') : t('quick.downloadFiles', { count: quick.files.value.length }) }}
        </div>
        <v-list density="compact" class="quick__file-list" rounded="md">
          <v-list-item
            v-for="file in visibleFiles"
            :key="file.index"
            v-bind="canOpenFiles ? {} : { href: quick.fileUrl(file), download: true }"
            :prepend-icon="canOpenFiles ? 'draft' : 'description'"
            @click="canOpenFiles ? openFile(file) : undefined"
          >
            <v-list-item-title class="text-body-2">{{ file.fileName }}</v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{ file.documentName }} &middot; {{ file.format }} &middot;
              {{ formatBytes(file.bytes) }}
            </v-list-item-subtitle>
            <template #append>
              <v-btn
                v-if="canOpenFiles"
                icon="folder_open"
                variant="text"
                density="comfortable"
                size="small"
                :title="t('quick.showInFolder')"
                @click.stop="revealFile(file)"
              />
              <v-icon v-else icon="download" size="small" class="quick__file-download" />
            </template>
          </v-list-item>
        </v-list>
        <!-- Folded rather than scrolled: a scroll area inside a page that already scrolls is
             two places to be lost in, and the count says what is behind it. -->
        <v-btn
          v-if="hiddenFileCount > 0 && !showAllFiles"
          variant="text"
          size="small"
          class="mt-1"
          @click="showAllFiles = true"
        >
          {{ t('quick.showMoreFiles', { count: hiddenFileCount }) }}
        </v-btn>
        <v-btn
          v-else-if="showAllFiles && hiddenFileCount > 0"
          variant="text"
          size="small"
          class="mt-1"
          @click="showAllFiles = false"
        >
          {{ t('quick.showFewerFiles') }}
        </v-btn>

        <p v-if="openError !== null" class="text-caption text-error mt-2 mb-0">
          {{ openError }}
        </p>
      </div>

      <!-- The same link, copyable. The button is a one-shot; this survives a reload and can be
           pasted somewhere, which is what "I will fetch it later" actually needs. -->
      <div v-if="quick.canDownload.value" class="quick__link mt-4">
        <span class="text-caption text-medium-emphasis">{{ t('quick.downloadLater') }}</span>
        <!-- An anchor, not a <code> block: it is a URL, and the obvious thing to do with one
             is click it. Still selectable, so copying it out for later works as before. -->
        <a class="quick__url" :href="quick.absoluteDownloadUrl.value" download>
          {{ quick.absoluteDownloadUrl.value }}
        </a>
        <span class="text-caption text-medium-emphasis">{{ t('quick.downloadExpires') }}</span>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.quick__formats-label {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
  font-size: 0.8125rem;
  opacity: 0.7;
}

.quick__files {
  max-width: 720px;
}

/* Bordered rather than floating: it is a list of links inside a card, and without an edge it
   reads as part of the paragraph above it. */
.quick__file-list {
  border: 1px solid rgb(var(--v-theme-outline-variant, 200, 200, 200));
  padding: 0;
}

.quick__file-download {
  opacity: 0.5;
}

.quick__header {
  margin-bottom: 20px;
}

.quick__title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.quick__link {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quick__url {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  word-break: break-all;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}

.quick__url:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}

.quick__status {
  display: flex;
  align-items: center;
  color: rgb(var(--v-theme-primary));
}

.quick__problems {
  margin: 0;
  padding-left: 18px;
}

.quick__formats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
</style>
