<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  isProcessableFile,
  PROCESSABLE_ACCEPT,
  PROCESSABLE_EXTENSIONS,
} from '@impressive-ocr/shared';
import { filesystemApi, type FolderEntry } from '../../../api/endpoints';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';

/**
 * Choose the files for a Quick run.
 *
 * Three situations, not two. In the desktop app the server *is* this computer, so the native
 * dialog hands back real paths and nothing is copied — one option, no choice to make. In a
 * browser there are genuinely two machines: this one (upload) and the server (browse). Upload
 * leads, because someone opening the UI in a browser is usually not sitting at the server.
 *
 * Selected files accumulate. Picking again adds to the list rather than replacing it, which is
 * what a plain file input does and what made adding a second file lose the first.
 */

const props = defineProps<{
  source: 'server' | 'upload';
  serverFiles: string[];
  uploadFiles: File[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:source': ['server' | 'upload'];
  'update:serverFiles': [string[]];
  'update:uploadFiles': [File[]];
}>();

const { t } = useI18n();
const desktop = useDesktopBridge();

const browsing = ref(false);
const currentPath = ref<string | null>(null);
const parentPath = ref<string | null>(null);
const entries = ref<FolderEntry[]>([]);
const loading = ref(false);
const browseError = ref<string | null>(null);
const rejected = ref<string[]>([]);

/** The hidden native input, driven by the visible button beside it. */
const uploadInput = ref<HTMLInputElement | null>(null);

/** The desktop has one machine, so offering a choice between two would be meaningless. */
const showSourceChoice = computed(() => !desktop.isDesktop.value);

const folders = computed(() => entries.value.filter((entry) => entry.isDirectory));

/** Only what the engine can read; anything else would fail after the run started. */
const files = computed(() =>
  entries.value.filter((entry) => !entry.isDirectory && isProcessableFile(entry.name)),
);

const hiddenFileCount = computed(
  () => entries.value.filter((entry) => !entry.isDirectory).length - files.value.length,
);

const selected = computed(() =>
  props.source === 'server'
    ? props.serverFiles.map((path) => ({ key: path, label: path, size: null as number | null }))
    : props.uploadFiles.map((file) => ({ key: file.name, label: file.name, size: file.size })),
);

/** Desktop: the native dialog. Browser: the server-side browser. */
async function chooseServerFiles(): Promise<void> {
  if (desktop.isDesktop.value) {
    const picked = await desktop.selectFiles({
      title: t('quick.chooseFiles'),
      extensions: [...PROCESSABLE_EXTENSIONS],
    });
    if (picked.length > 0) addServerFiles(picked);
    return;
  }

  browsing.value = true;
  await navigate(null);
}

async function navigate(path: string | null): Promise<void> {
  loading.value = true;
  browseError.value = null;
  try {
    const result = await filesystemApi.browse(path, 'system', true);
    currentPath.value = result.currentPath;
    parentPath.value = result.parentPath;
    entries.value = result.entries;
  } catch (error) {
    browseError.value = error instanceof Error ? error.message : t('quick.browseFailed');
  } finally {
    loading.value = false;
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

function toggleServerFile(path: string): void {
  if (props.serverFiles.includes(path)) {
    emit(
      'update:serverFiles',
      props.serverFiles.filter((entry) => entry !== path),
    );
  } else {
    addServerFiles([path]);
  }
}

/**
 * Take a browser file selection, adding to what is already chosen.
 *
 * A file input replaces its value every time it is used, so without merging here the second
 * trip to the dialog silently discarded the first.
 */
function onUploadPicked(event: Event): void {
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

    <div class="d-flex ga-3 flex-wrap align-center mb-3">
      <v-btn
        v-if="source === 'server'"
        variant="tonal"
        color="primary"
        prepend-icon="folder_open"
        :disabled="disabled"
        @click="chooseServerFiles"
      >
        {{ t('quick.addFiles') }}
      </v-btn>

      <template v-else>
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
          @click="uploadInput?.click()"
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

    <p v-else class="text-body-2 text-medium-emphasis">{{ t('quick.noFilesYet') }}</p>

    <v-dialog v-model="browsing" max-width="720">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ t('quick.addFiles') }}</v-card-title>
        <v-card-subtitle class="text-caption">
          {{ currentPath ?? t('quick.thisComputer') }}
        </v-card-subtitle>

        <v-card-text style="max-height: 60vh; overflow-y: auto">
          <v-alert v-if="browseError" type="error" density="compact" class="mb-3">
            {{ browseError }}
          </v-alert>
          <v-progress-linear v-if="loading" indeterminate class="mb-2" />

          <v-list density="compact">
            <v-list-item
              v-if="parentPath !== null"
              prepend-icon="arrow_upward"
              :title="t('quick.up')"
              @click="navigate(parentPath)"
            />
            <v-list-item
              v-for="folder in folders"
              :key="folder.path"
              prepend-icon="folder"
              :title="folder.name"
              :disabled="!folder.isAccessible"
              @click="navigate(folder.path)"
            />
            <v-list-item
              v-for="file in files"
              :key="file.path"
              :title="file.name"
              :subtitle="formatSize(file.sizeBytes)"
              @click="toggleServerFile(file.path)"
            >
              <template #prepend>
                <v-checkbox-btn
                  :model-value="serverFiles.includes(file.path)"
                  density="compact"
                  @click.stop="toggleServerFile(file.path)"
                />
              </template>
            </v-list-item>
          </v-list>

          <p v-if="hiddenFileCount > 0" class="text-caption text-medium-emphasis mt-2">
            {{ t('quick.hiddenFiles', { count: hiddenFileCount }) }}
          </p>
        </v-card-text>

        <v-card-actions>
          <span class="text-caption text-medium-emphasis ml-2">
            {{ t('quick.selectedCount', { count: serverFiles.length }) }}
          </span>
          <v-spacer />
          <v-btn variant="text" @click="browsing = false">{{ t('quick.done') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/* Driven by the button beside it; the native control is never shown. */
.quick-picker__input {
  display: none;
}

.quick-picker__list {
  max-height: 260px;
  overflow-y: auto;
}
</style>
