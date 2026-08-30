<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { isProcessableFile } from '@impressive-ocr/shared';
import { filesystemApi, type FolderEntry } from '../../../api/endpoints';
import { parentFolderOf, rememberInputFolder } from '../composables/last-folder';

/**
 * Browsing the server's filesystem to pick files, for the browser build.
 *
 * The desktop has a native dialog and never opens this. A web page cannot read a directory
 * and `showDirectoryPicker()` returns an opaque handle rather than a path, so when the UI is
 * not the machine holding the files this is the only way to name one.
 */

const props = defineProps<{
  /** Whether the dialog is open. */
  modelValue: boolean;
  /** Absolute paths already chosen, so the checkboxes reflect the real selection. */
  selected: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [boolean];
  'update:selected': [string[]];
}>();

const { t } = useI18n();

const currentPath = ref<string | null>(null);
const parentPath = ref<string | null>(null);
const entries = ref<FolderEntry[]>([]);
const loading = ref(false);
const browseError = ref<string | null>(null);

const folders = computed(() => entries.value.filter((entry) => entry.isDirectory));

/** Only what the engine can read; anything else would fail after the run started. */
const files = computed(() =>
  entries.value.filter((entry) => !entry.isDirectory && isProcessableFile(entry.name)),
);

const hiddenFileCount = computed(
  () => entries.value.filter((entry) => !entry.isDirectory).length - files.value.length,
);

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

/** Opened by the parent; starts where the last file was picked rather than at the root. */
defineExpose({ open: (startAt: string | null) => navigate(startAt) });

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function toggle(path: string): void {
  if (props.selected.includes(path)) {
    emit(
      'update:selected',
      props.selected.filter((entry) => entry !== path),
    );
    return;
  }
  rememberInputFolder(parentFolderOf(path));
  emit('update:selected', [...props.selected, path]);
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="720"
    @update:model-value="emit('update:modelValue', $event)"
  >
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
            @click="toggle(file.path)"
          >
            <template #prepend>
              <v-checkbox-btn
                :model-value="selected.includes(file.path)"
                density="compact"
                @click.stop="toggle(file.path)"
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
          {{ t('quick.selectedCount', { count: selected.length }) }}
        </span>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">
          {{ t('quick.done') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
