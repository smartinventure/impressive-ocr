<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  isProcessableFile,
  PROCESSABLE_ACCEPT,
  PROCESSABLE_EXTENSIONS,
} from '@impressive-ocr/shared';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';
import { useFolderPreviews } from '../composables/use-folder-previews';
import { parentFolderOf, recallInputFolder, rememberInputFolder } from '../composables/last-folder';
import ServerFileBrowser from './server-file-browser.vue';

/**
 * Choose what a Quick run reads: named files, or whole folders.
 *
 * Three situations, not two. In the desktop app the server *is* this computer, so the native
 * dialog hands back real paths and nothing is copied — one option, no choice to make. In a
 * browser there are genuinely two machines: this one (upload) and the server (browse). Upload
 * leads, because someone opening the UI in a browser is usually not sitting at the server.
 *
 * Files and folders are mutually exclusive, and enforced by disabling rather than by clearing.
 * They are not the same kind of choice — named files are a list the user curates, a folder is
 * a standing instruction whose contents the server resolves — and a run mixing them would show
 * a count that did not match what ran. Silently discarding one when the other is used looks
 * like a bug; a disabled button that says why teaches the rule once.
 */

const props = defineProps<{
  source: 'server' | 'upload';
  serverFiles: string[];
  uploadFiles: File[];
  /** Folders to take the files from instead, expanded by the server. */
  serverFolders: string[];
  /** Which types to take from those folders, without the dot. */
  folderExtensions: string[];
  /** What those folders and types come to; counted here, needed by the Start button. */
  folderFileCount: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:source': ['server' | 'upload'];
  'update:serverFiles': [string[]];
  'update:uploadFiles': [File[]];
  'update:serverFolders': [string[]];
  'update:folderExtensions': [string[]];
  'update:folderFileCount': [number];
}>();

const { t } = useI18n();
const desktop = useDesktopBridge();

/**
 * True while a file dialog is being opened.
 *
 * The desktop path is the one that needed it: `selectFiles` crosses to the main process and
 * puts up a native modal, and until it comes back the window genuinely cannot repaint. With
 * no spinner on the button that is indistinguishable from the app having hung, which is
 * exactly how it was reported.
 */
const picking = ref(false);
const pickingFolder = ref(false);
const browsing = ref(false);
const rejected = ref<string[]>([]);

/** The hidden native input, driven by the visible button beside it. */
const uploadInput = ref<HTMLInputElement | null>(null);
const browser = ref<InstanceType<typeof ServerFileBrowser> | null>(null);

/** The desktop has one machine, so offering a choice between two would be meaningless. */
const showSourceChoice = computed(() => !desktop.isDesktop.value);

const selectedExtensions = computed(() => props.folderExtensions);
const previews = useFolderPreviews(selectedExtensions);

// The count belongs to the Start button, which lives two components up. Emitted rather than
// recomputed there because only this side holds the per-folder listings it comes from.
watch(previews.selectedFileCount, (count) => emit('update:folderFileCount', count), {
  immediate: true,
});

/** Chips for types no chosen folder holds would offer a filter that does nothing. */
const extensionChips = computed(() => previews.availableExtensions.value);

const hasFolders = computed(() => props.serverFolders.length > 0);
const hasFiles = computed(() => props.serverFiles.length > 0);

/**
 * Only where a folder can actually be chosen.
 *
 * `selectFolder` needs the desktop bridge; in a browser it returns null and the button would
 * open nothing and say nothing. The browse dialog is no substitute — it walks folders but
 * only selects files, which is the opposite of what this asks for.
 */
const canPickFolder = computed(() => props.source === 'server' && desktop.isDesktop.value);

/** Why a button is greyed out, or what it does when it is not. */
const addFilesHint = computed(() =>
  hasFolders.value ? t('quick.filesBlockedByFolder') : t('quick.addFilesHint'),
);
const addFolderHint = computed(() =>
  hasFiles.value ? t('quick.folderBlockedByFiles') : t('quick.addFolderHint'),
);

const selected = computed(() =>
  props.source === 'server'
    ? props.serverFiles.map((path) => ({ key: path, label: path, size: null as number | null }))
    : props.uploadFiles.map((file) => ({ key: file.name, label: file.name, size: file.size })),
);

/** Add a folder to the list, count it, and remember where the dialog got to. */
async function chooseServerFolder(): Promise<void> {
  pickingFolder.value = true;
  try {
    const startAt = recallInputFolder();
    const chosen = await desktop.selectFolder({
      title: t('quick.chooseFolder'),
      ...(startAt === undefined ? {} : { defaultPath: startAt }),
    });
    if (chosen === null) return;

    rememberInputFolder(chosen);
    // The same folder twice would double every count and queue every file twice.
    if (!props.serverFolders.includes(chosen)) {
      emit('update:serverFolders', [...props.serverFolders, chosen]);
    }
    await previews.load(chosen);
  } finally {
    pickingFolder.value = false;
  }
}

function removeFolder(path: string): void {
  previews.forget(path);
  emit(
    'update:serverFolders',
    props.serverFolders.filter((entry) => entry !== path),
  );
}

function toggleExtension(extension: string): void {
  const next = props.folderExtensions.includes(extension)
    ? props.folderExtensions.filter((item) => item !== extension)
    : [...props.folderExtensions, extension];
  emit('update:folderExtensions', next);
}

async function chooseServerFiles(): Promise<void> {
  picking.value = true;
  try {
    if (desktop.isDesktop.value) {
      const startAt = recallInputFolder();
      const picked = await desktop.selectFiles({
        title: t('quick.chooseFiles'),
        extensions: [...PROCESSABLE_EXTENSIONS],
        ...(startAt === undefined ? {} : { defaultPath: startAt }),
      });
      if (picked.length > 0) {
        rememberInputFolder(parentFolderOf(picked[picked.length - 1] ?? ''));
        addServerFiles(picked);
      }
      return;
    }

    browsing.value = true;
    await browser.value?.open(recallInputFolder() ?? null);
  } finally {
    picking.value = false;
  }
}

/** Add without duplicating: picking the same file twice should not queue it twice. */
function addServerFiles(paths: readonly string[]): void {
  const merged = [...props.serverFiles];
  for (const path of paths) {
    if (!merged.includes(path)) merged.push(path);
  }
  emit('update:serverFiles', merged);
}

/**
 * Take a browser file selection, adding to what is already chosen.
 *
 * A file input replaces its value every time it is used, so without merging here the second
 * trip to the dialog silently discarded the first.
 */
function onUploadPicked(event: Event): void {
  picking.value = false;

  const input = event.target as HTMLInputElement;
  const picked = [...(input.files ?? [])];

  const accepted = picked.filter((file) => isProcessableFile(file.name));
  rejected.value = picked.filter((file) => !isProcessableFile(file.name)).map((file) => file.name);

  const merged = [...props.uploadFiles];
  for (const file of accepted) {
    // Name and size together: the same document picked twice is one job, but two different
    // files that happen to share a name are not.
    if (!merged.some((existing) => existing.name === file.name && existing.size === file.size)) {
      merged.push(file);
    }
  }
  emit('update:uploadFiles', merged);

  // Reset, or picking the same file again fires no change event at all.
  input.value = '';
}

/**
 * Open the browser's file dialog, showing the button as busy until it returns.
 *
 * `cancel` fires when the dialog is dismissed without a selection; without listening for it
 * the button would spin forever for anyone who opened the dialog and changed their mind.
 * Older browsers do not emit it, so the spinner is also cleared by the change handler.
 */
function openUploadDialog(): void {
  const input = uploadInput.value;
  if (input === null) return;

  picking.value = true;
  input.addEventListener('cancel', () => (picking.value = false), { once: true });
  input.click();
}

function removeAt(index: number): void {
  if (props.source === 'server') {
    emit(
      'update:serverFiles',
      props.serverFiles.filter((_, position) => position !== index),
    );
  } else {
    emit(
      'update:uploadFiles',
      props.uploadFiles.filter((_, position) => position !== index),
    );
  }
}

function clearAll(): void {
  emit('update:serverFiles', []);
  emit('update:uploadFiles', []);
  rejected.value = [];
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
</script>

<template>
  <div>
    <!-- Browser only: on the desktop there is one machine and nothing to choose between. -->
    <v-btn-toggle
      v-if="showSourceChoice"
      :model-value="source"
      mandatory
      density="comfortable"
      variant="outlined"
      divided
      class="mb-4"
      :disabled="disabled"
      @update:model-value="emit('update:source', $event)"
    >
      <v-btn value="upload" prepend-icon="computer">{{ t('quick.sourceUpload') }}</v-btn>
      <v-btn value="server" prepend-icon="dns">{{ t('quick.sourceServer') }}</v-btn>
    </v-btn-toggle>

    <!-- The two ways in, explained before they are offered. What happens to the originals is
         the part that differs, and not something to discover afterwards. -->
    <div v-if="source === 'server'" class="text-body-2 text-medium-emphasis mb-3">
      <p class="mb-1">{{ t('quick.pickIntroFiles') }}</p>
      <p class="mb-0">{{ t('quick.pickIntroFolders') }}</p>
    </div>

    <div class="d-flex ga-3 flex-wrap align-center mb-3">
      <!-- A disabled button emits no pointer events, so a tooltip bound to one never opens.
           The hint goes on a wrapping span, which does. -->
      <span v-if="source === 'server'" :title="addFilesHint">
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="description"
          :disabled="disabled || hasFolders"
          :loading="picking"
          @click="chooseServerFiles"
        >
          {{ t('quick.addFiles') }}
        </v-btn>
      </span>

      <!-- Whole folders, as an alternative to naming their files. The server lists them: a web
           page cannot read a directory, and the desktop's dialog hands back the folder rather
           than what is in it. -->
      <span v-if="canPickFolder" :title="addFolderHint">
        <v-btn
          variant="tonal"
          prepend-icon="folder_open"
          :disabled="disabled || hasFiles"
          :loading="pickingFolder"
          @click="chooseServerFolder"
        >
          {{ t('quick.addFolder') }}
        </v-btn>
      </span>

      <!-- Its own condition, not `v-else`. `v-else` binds to whatever `v-if` precedes it, so
           adding the folder button above silently re-pointed this at *that* condition: in a
           browser, where a folder cannot be picked, the upload branch rendered beside the
           server one and Quick Mode showed two buttons both saying "Add files". Stated
           positively, it cannot be broken by inserting something above it again. -->
      <template v-if="source === 'upload'">
        <input
          ref="uploadInput"
          type="file"
          multiple
          class="quick-picker__input"
          :accept="PROCESSABLE_ACCEPT"
          :disabled="disabled"
          @change="onUploadPicked"
        />
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="upload_file"
          :disabled="disabled"
          :loading="picking"
          @click="openUploadDialog"
        >
          {{ t('quick.addFiles') }}
        </v-btn>
      </template>

      <v-btn
        v-if="selected.length > 0"
        variant="text"
        size="small"
        prepend-icon="close"
        :disabled="disabled"
        @click="clearAll"
      >
        {{ t('quick.clearAll') }}
      </v-btn>

      <span v-if="selected.length > 0" class="text-caption text-medium-emphasis">
        {{ t('quick.selectedCount', { count: selected.length }) }}
      </span>
    </div>

    <!-- The folders, and what will be taken from them. The chips are the only place the run's
         scope is visible: the file list stays empty because the server does the listing. -->
    <div v-if="hasFolders" class="quick-picker__folder mb-3">
      <div
        v-for="folder in serverFolders"
        :key="folder"
        class="d-flex align-center ga-2 mb-1 flex-wrap"
      >
        <v-icon icon="folder_open" size="18" />
        <span class="ocr-mono text-body-2">{{ folder }}</span>
        <span v-if="previews.errors.value[folder]" class="text-caption text-error">
          {{ previews.errors.value[folder] }}
        </span>
        <span v-else class="text-caption text-medium-emphasis">
          {{ t('quick.folderFileCount', { count: previews.countFor(folder) }) }}
        </span>
        <v-btn
          icon="close"
          size="x-small"
          variant="text"
          :title="t('quick.clearFolder')"
          :disabled="disabled"
          @click="removeFolder(folder)"
        />
      </div>

      <div v-if="extensionChips.length > 0" class="d-flex ga-2 flex-wrap mt-2">
        <v-chip
          v-for="extension in extensionChips"
          :key="extension"
          size="small"
          label
          :variant="folderExtensions.includes(extension) ? 'flat' : 'outlined'"
          :color="folderExtensions.includes(extension) ? 'primary' : undefined"
          :disabled="disabled"
          @click="toggleExtension(extension)"
        >
          {{ extension.toUpperCase() }}
        </v-chip>
      </div>

      <v-progress-circular
        v-if="previews.loading.value"
        indeterminate
        size="16"
        width="2"
        class="mt-2"
      />
      <template v-else>
        <p class="text-body-2 mt-2 mb-0">
          {{ t('quick.folderTotal', { count: previews.selectedFileCount.value }) }}
        </p>
        <p v-if="previews.unreadableCount.value > 0" class="text-caption text-medium-emphasis mb-0">
          {{ t('quick.folderUnreadable', { count: previews.unreadableCount.value }) }}
        </p>
        <p v-if="extensionChips.length === 0" class="text-caption text-error mt-2 mb-0">
          {{ t('quick.folderNothingReadable') }}
        </p>
        <!-- Keyed on the count, not on the selection. The selection holds every readable type
             by default, so unticking the one chip a folder actually offers leaves seven others
             selected and this would never fire -- while nothing at all would be read. -->
        <p
          v-else-if="previews.selectedFileCount.value === 0"
          class="text-caption text-error mt-2 mb-0"
        >
          {{ t('quick.noExtensions') }}
        </p>
      </template>
    </div>

    <v-alert
      v-if="rejected.length > 0"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-3"
    >
      {{ t('quick.rejectedFiles', { names: rejected.join(', ') }) }}
    </v-alert>

    <!-- The chosen files, listed below the button rather than crammed into it. -->
    <v-list v-if="selected.length > 0" density="compact" class="quick-picker__list" border rounded>
      <v-list-item v-for="(item, index) in selected" :key="item.key" :title="item.label">
        <template #prepend><v-icon icon="description" size="18" /></template>
        <template #append>
          <span v-if="item.size !== null" class="text-caption text-medium-emphasis mr-2">
            {{ formatSize(item.size) }}
          </span>
          <v-btn
            icon="close"
            size="x-small"
            variant="text"
            :disabled="disabled"
            @click="removeAt(index)"
          />
        </template>
      </v-list-item>
    </v-list>

    <p v-else-if="!hasFolders" class="text-body-2 text-medium-emphasis">
      {{ t('quick.noFilesYet') }}
    </p>

    <ServerFileBrowser
      ref="browser"
      v-model="browsing"
      :selected="serverFiles"
      @update:selected="emit('update:serverFiles', $event)"
    />
  </div>
</template>

<style scoped>
/* Boxed so the folders and their types read as one choice rather than several loose rows. */
.quick-picker__folder {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 8px;
  padding: 12px;
}

/* Driven by the button beside it; the native control is never shown. */
.quick-picker__input {
  display: none;
}

.quick-picker__list {
  max-height: 260px;
  overflow-y: auto;
}
</style>
