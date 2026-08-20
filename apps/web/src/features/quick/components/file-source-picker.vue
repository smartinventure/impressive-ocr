<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { filesystemApi, type FolderEntry } from '../../../api/endpoints';

/**
 * Choose the files for a Quick run, either from the server or from this computer.
 *
 * Both exist because a browser cannot hand the server a usable path. On the machine running
 * the service, picking server-side files copies nothing and has no size limit. When the UI is
 * open somewhere else, uploading is the only way — and then the results have to come back as
 * a download rather than being written somewhere unreachable.
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

const browsing = ref(false);
const currentPath = ref<string | null>(null);
const entries = ref<FolderEntry[]>([]);
const loading = ref(false);
const browseError = ref<string | null>(null);
const parentPath = ref<string | null>(null);

const folders = computed(() => entries.value.filter((entry) => entry.isDirectory));
const files = computed(() => entries.value.filter((entry) => !entry.isDirectory));

async function openBrowser(): Promise<void> {
  browsing.value = true;
  await navigate(null);
}

async function navigate(path: string | null): Promise<void> {
  loading.value = true;
  browseError.value = null;
  try {
    // `system` scope and files included: Quick Mode is explicitly about reaching files the
    // user has not set up a pipeline for.
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

function toggleFile(path: string): void {
  const next = props.serverFiles.includes(path)
    ? props.serverFiles.filter((entry) => entry !== path)
    : [...props.serverFiles, path];
  emit('update:serverFiles', next);
}

function onUploadChange(value: unknown): void {
  const list = Array.isArray(value) ? value : value instanceof File ? [value] : [];
  emit('update:uploadFiles', list as File[]);
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
    <v-btn-toggle
      :model-value="source"
      mandatory
      density="comfortable"
      variant="outlined"
      divided
      class="mb-4"
      :disabled="disabled"
      @update:model-value="emit('update:source', $event)"
    >
      <v-btn value="server" prepend-icon="dns">{{ t('quick.sourceServer') }}</v-btn>
      <v-btn value="upload" prepend-icon="upload">{{ t('quick.sourceUpload') }}</v-btn>
    </v-btn-toggle>

    <!-- Files on the machine running the service -->
    <div v-if="source === 'server'">
      <v-btn
        variant="tonal"
        color="primary"
        prepend-icon="folder_open"
        :disabled="disabled"
        @click="openBrowser"
      >
        {{ t('quick.chooseFiles') }}
      </v-btn>

      <v-list v-if="serverFiles.length > 0" density="compact" class="mt-3">
        <v-list-item v-for="path in serverFiles" :key="path" :title="path">
          <template #prepend><v-icon icon="description" size="18" /></template>
          <template #append>
            <v-btn
              icon="close"
              size="x-small"
              variant="text"
              :disabled="disabled"
              @click="toggleFile(path)"
            />
          </template>
        </v-list-item>
      </v-list>
    </div>

    <!-- Files from this computer -->
    <v-file-input
      v-else
      :model-value="uploadFiles"
      multiple
      chips
      show-size
      variant="outlined"
      density="comfortable"
      prepend-icon="upload_file"
      :label="t('quick.uploadLabel')"
      :hint="t('quick.uploadHint')"
      persistent-hint
      :disabled="disabled"
      @update:model-value="onUploadChange"
    />

    <v-dialog v-model="browsing" max-width="720">
      <v-card>
        <v-card-title class="text-subtitle-1">{{ t('quick.chooseFiles') }}</v-card-title>
        <v-card-subtitle class="text-caption">{{
          currentPath ?? t('quick.thisComputer')
        }}</v-card-subtitle>

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
              @click="toggleFile(file.path)"
            >
              <template #prepend>
                <v-checkbox-btn
                  :model-value="serverFiles.includes(file.path)"
                  density="compact"
                  @click.stop="toggleFile(file.path)"
                />
              </template>
            </v-list-item>
          </v-list>
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
