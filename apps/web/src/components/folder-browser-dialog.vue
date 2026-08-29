<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { filesystemApi, type BrowseResult, type FolderEntry } from '../api/endpoints';
import { ApiRequestError } from '../api/client';

/**
 * Server-side folder browser.
 *
 * The browser's own pickers cannot supply an absolute path — `webkitdirectory` yields
 * relative names and `showDirectoryPicker()` an opaque handle — but the server has to be
 * given a real path in order to watch a folder. So the listing comes from the server, and
 * this dialog is a view onto it.
 */

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** `allowlist` confines browsing to authorised folders; `system` browses the machine. */
    scope?: 'allowlist' | 'system';
    startPath?: string | null;
    title?: string;
  }>(),
  { scope: 'allowlist', startPath: null, title: undefined },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  select: [path: string];
}>();

const { t } = useI18n();

const listing = ref<BrowseResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const filter = ref('');
const creating = ref(false);
const newFolderName = ref('');

const entries = computed(() => {
  const all = listing.value?.entries ?? [];
  const needle = filter.value.trim().toLowerCase();
  return needle.length === 0
    ? all
    : all.filter((entry) => entry.name.toLowerCase().includes(needle));
});

/** Breadcrumbs from the current path, so a deep folder is still navigable. */
const crumbs = computed(() => {
  const current = listing.value?.currentPath;
  if (current === null || current === undefined) {
    return [];
  }
  const separator = current.includes('\\') ? '\\' : '/';
  const parts = current.split(separator).filter((part) => part.length > 0);
  const result: { label: string; path: string }[] = [];
  let accumulated = current.startsWith(separator) ? separator : '';

  for (const [index, part] of parts.entries()) {
    accumulated =
      index === 0 && accumulated === ''
        ? `${part}${separator}`
        : `${accumulated}${part}${separator}`;
    result.push({ label: part, path: accumulated });
  }
  return result;
});

const canSelectCurrent = computed(
  () => listing.value !== null && listing.value.currentPath !== null && listing.value.selectable,
);

async function load(path: string | null): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    listing.value = await filesystemApi.browse(path, props.scope);
    filter.value = '';
  } catch (caught) {
    error.value =
      caught instanceof ApiRequestError ? caught.message : t('folderBrowser.loadFailed');
    // A 404 leaves the previous listing on screen so the user is not stranded on an
    // error page with nothing to click.
  } finally {
    loading.value = false;
  }
}

async function createFolder(): Promise<void> {
  const parent = listing.value?.currentPath;
  const name = newFolderName.value.trim();
  if (parent === null || parent === undefined || name.length === 0) {
    return;
  }
  const separator = parent.includes('\\') ? '\\' : '/';
  const target = `${parent}${parent.endsWith(separator) ? '' : separator}${name}`;

  try {
    const created = await filesystemApi.createFolder(target, props.scope);
    creating.value = false;
    newFolderName.value = '';
    // Navigate into it: creating a folder is almost always the step before choosing it.
    await load(created.path);
  } catch (caught) {
    error.value =
      caught instanceof ApiRequestError ? caught.message : t('folderBrowser.createFailed');
  }
}

function open(entry: FolderEntry): void {
  if (entry.isAccessible) {
    void load(entry.path);
  }
}

function choose(path: string | null): void {
  if (path !== null) {
    emit('select', path);
    emit('update:modelValue', false);
  }
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      void load(props.startPath);
    }
  },
  { immediate: true },
);
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="720"
    scrollable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-card>
      <v-card-title class="d-flex align-center ga-2 py-4">
        <v-icon icon="folder_open" size="22" />
        <span>{{ title ?? t('folderBrowser.title') }}</span>
        <v-spacer />
        <v-btn icon="close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-card-title>

      <v-divider />

      <div class="px-4 py-3 d-flex align-center ga-2 flex-wrap">
        <v-btn
          icon="home"
          variant="text"
          size="small"
          :title="t('folderBrowser.roots')"
          @click="load(null)"
        />
        <v-btn
          icon="arrow_upward"
          variant="text"
          size="small"
          :disabled="listing?.parentPath == null"
          :title="t('folderBrowser.up')"
          @click="load(listing?.parentPath ?? null)"
        />
        <v-btn
          icon="refresh"
          variant="text"
          size="small"
          :title="t('folderBrowser.refresh')"
          @click="load(listing?.currentPath ?? null)"
        />
        <v-text-field
          v-model="filter"
          :placeholder="t('folderBrowser.filter')"
          density="compact"
          prepend-inner-icon="search"
          hide-details
          class="flex-grow-1"
          style="min-width: 180px"
        />
        <v-btn
          icon="create_new_folder"
          variant="text"
          size="small"
          :disabled="listing?.currentPath == null"
          :title="t('folderBrowser.newFolder')"
          @click="creating = !creating"
        />
      </div>

      <div v-if="crumbs.length > 0" class="px-4 pb-2 folder-browser__crumbs">
        <button type="button" class="folder-browser__crumb" @click="load(null)">
          {{ t('folderBrowser.roots') }}
        </button>
        <template v-for="crumb in crumbs" :key="crumb.path">
          <span class="folder-browser__sep">/</span>
          <button type="button" class="folder-browser__crumb" @click="load(crumb.path)">
            {{ crumb.label }}
          </button>
        </template>
      </div>

      <div v-if="creating" class="px-4 pb-3 d-flex ga-2">
        <v-text-field
          v-model="newFolderName"
          :label="t('folderBrowser.folderName')"
          density="compact"
          autofocus
          @keyup.enter="createFolder"
        />
        <v-btn color="primary" :disabled="newFolderName.trim().length === 0" @click="createFolder">
          {{ t('common.create') }}
        </v-btn>
      </div>

      <v-divider />

      <v-card-text style="min-height: 320px; max-height: 420px">
        <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-2" />

        <p v-if="!loading && entries.length === 0" class="text-medium-emphasis pa-4 text-center">
          {{ t('folderBrowser.empty') }}
        </p>

        <v-list v-else density="compact" class="py-0">
          <v-list-item
            v-for="entry in entries"
            :key="entry.path"
            :disabled="!entry.isAccessible"
            rounded="md"
            @click="open(entry)"
          >
            <template #prepend>
              <v-icon
                :icon="entry.isAccessible ? 'folder' : 'folder_off'"
                :color="entry.selectable ? 'primary' : undefined"
                size="20"
              />
            </template>
            <v-list-item-title>
              <!-- Under a mounted host, the operator's own path rather than the container's:
                   they came looking for /mnt/scans, not /host/mnt/scans. -->
              {{ entry.hostPath ?? entry.name }}
              <v-chip
                v-if="entry.hostPath !== null"
                size="x-small"
                color="succeeded"
                variant="tonal"
                label
                class="ml-2"
              >
                {{ t('folderBrowser.hostChip') }}
                <!-- The container path is still what pipelines store and what appears in the
                     log, so it has to be reachable from here. -->
                <v-tooltip activator="parent" location="top" max-width="320">
                  {{ t('folderBrowser.hostTooltip', { path: entry.path }) }}
                </v-tooltip>
              </v-chip>
            </v-list-item-title>
            <v-list-item-subtitle v-if="!entry.isAccessible">
              {{ t('folderBrowser.inaccessible') }}
            </v-list-item-subtitle>
            <template #append>
              <v-btn
                v-if="entry.selectable && entry.isAccessible"
                size="x-small"
                variant="tonal"
                @click.stop="choose(entry.path)"
              >
                {{ t('common.select') }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>

        <p v-if="listing?.truncated" class="text-caption text-medium-emphasis pt-2">
          {{ t('folderBrowser.truncated') }}
        </p>
      </v-card-text>

      <v-divider />

      <v-card-actions class="px-4 py-3">
        <span class="folder-browser__current">{{
          listing?.currentPath ?? t('folderBrowser.roots')
        }}</span>
        <v-spacer />
        <v-btn variant="text" @click="emit('update:modelValue', false)">
          {{ t('common.cancel') }}
        </v-btn>
        <v-btn
          color="primary"
          :disabled="!canSelectCurrent"
          @click="choose(listing?.currentPath ?? null)"
        >
          {{ t('folderBrowser.useThisFolder') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.folder-browser__crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
}

.folder-browser__crumb {
  background: none;
  border: none;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface-variant));
  font: inherit;
}

.folder-browser__crumb:hover {
  background: rgb(var(--v-theme-primary-container));
  color: rgb(var(--v-theme-on-primary-container));
}

.folder-browser__sep {
  color: var(--ocr-on-surface-muted);
}

.folder-browser__current {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  color: rgb(var(--v-theme-on-surface-variant));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
</style>
