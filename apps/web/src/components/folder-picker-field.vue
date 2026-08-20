<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { settingsApi } from '../api/endpoints';
import { useDesktopBridge } from '../composables/use-desktop-bridge';
import FolderBrowserDialog from './folder-browser-dialog.vue';

/**
 * A path input with a browse button — the pattern used for every folder in the app.
 *
 * The path can always be typed, and is validated against the server as it is. Typing matters
 * more than it looks: a UNC path like `\\nas01\archiv` is far quicker to paste than to
 * navigate to, and in headless mode it may be the only way in if the share is not mounted
 * where the browser starts.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    hint?: string;
    scope?: 'allowlist' | 'system';
    /** Output folders are created on first write, so they need not exist yet. */
    mustExist?: boolean;
    /** Server-side field error, e.g. from a rejected pipeline save. */
    externalError?: string | null;
    disabled?: boolean;
  }>(),
  {
    hint: undefined,
    scope: 'allowlist',
    mustExist: true,
    externalError: null,
    disabled: false,
  },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();
const desktop = useDesktopBridge();

const browsing = ref(false);
const validationMessage = ref<string | null>(null);
const validating = ref(false);
const isValid = ref<boolean | null>(null);

let validationToken = 0;

/**
 * Validate against the server, debounced.
 *
 * Only the server can answer this: it knows the allowlist, and it is the process that has to
 * be able to reach the folder. A client-side regex would happily accept a path this machine
 * cannot see.
 */
async function validate(path: string): Promise<void> {
  const token = ++validationToken;
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    validationMessage.value = null;
    isValid.value = null;
    return;
  }

  validating.value = true;
  try {
    const result = await settingsApi.validateFolder(trimmed, props.mustExist);
    // A slower earlier request must not overwrite a newer answer.
    if (token !== validationToken) {
      return;
    }
    isValid.value = result.valid;
    validationMessage.value = result.valid ? null : result.message;
  } catch {
    if (token === validationToken) {
      isValid.value = null;
      validationMessage.value = null;
    }
  } finally {
    if (token === validationToken) {
      validating.value = false;
    }
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.modelValue,
  (value) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void validate(value), 400);
  },
  { immediate: true },
);

function onSelect(path: string): void {
  emit('update:modelValue', path);
}

/**
 * Prefer the OS dialog, fall back to the in-app browser.
 *
 * On the desktop the native chooser is both more familiar and more capable — it can reach any
 * folder and create one in place. In a browser it does not exist, and no web API can return an
 * absolute path, so the server-side browser is the only option there.
 */
async function browse(): Promise<void> {
  if (!desktop.isDesktop.value) {
    browsing.value = true;
    return;
  }

  const current = props.modelValue.trim();
  const picked = await desktop.selectFolder({
    title: props.label,
    defaultPath: current.length > 0 ? current : undefined,
    // Output and archive folders routinely do not exist yet.
    allowCreate: !props.mustExist,
  });

  if (picked !== null) {
    onSelect(picked);
  }
}
</script>

<template>
  <div class="folder-picker">
    <v-text-field
      :model-value="modelValue"
      :label="label"
      :hint="hint"
      :disabled="disabled"
      persistent-hint
      class="folder-picker__input"
      :error-messages="externalError ?? validationMessage ?? undefined"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <template #prepend-inner>
        <v-icon icon="folder" size="20" class="folder-picker__leading" />
      </template>

      <template #append-inner>
        <v-progress-circular v-if="validating" indeterminate size="16" width="2" />
        <v-icon
          v-else-if="isValid === true && externalError === null"
          icon="check_circle"
          size="18"
          color="succeeded"
        />
      </template>

      <template #append>
        <v-btn
          :disabled="disabled"
          variant="tonal"
          color="primary"
          class="folder-picker__browse"
          :title="t('folderPicker.browse')"
          @click="browse"
        >
          <v-icon icon="folder_open" size="20" />
          <span class="d-none d-sm-inline ml-2">{{ t('folderPicker.browse') }}</span>
        </v-btn>
      </template>
    </v-text-field>

    <FolderBrowserDialog
      v-model="browsing"
      :scope="scope"
      :start-path="modelValue.trim().length > 0 ? modelValue : null"
      @select="onSelect"
    />
  </div>
</template>

<style scoped>
.folder-picker__input :deep(input) {
  /* Paths are read character by character when something is wrong; a proportional font
     makes a doubled separator or a stray space genuinely hard to spot. */
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
}

.folder-picker__leading {
  opacity: 0.6;
}

.folder-picker__browse {
  align-self: center;
}
</style>
