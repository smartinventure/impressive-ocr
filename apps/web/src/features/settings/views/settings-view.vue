<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import type { AppSettings } from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { settingsApi } from '../../../api/endpoints';
import FolderBrowserDialog from '../../../components/folder-browser-dialog.vue';
import PasswordCard from '../components/password-card.vue';
import LicenseCard from '../../system/components/license-card.vue';
import { setLocale, type AppLocale } from '../../../plugins/i18n';
import { useDesktopBridge } from '../../../composables/use-desktop-bridge';

/**
 * Settings, including the folder allowlist.
 *
 * The allowlist is the app's security boundary: nothing outside it can be read or written.
 * Adding to it therefore browses with `system` scope — the allowlist cannot bootstrap itself
 * from inside its own confinement.
 */

const { t, locale } = useI18n();

/**
 * Which tab is open, kept in the URL rather than in a ref alone.
 *
 * Someone sent "look at Settings → License" needs a link that lands there, and a page reload
 * after saving should not throw them back to the first tab. `replace` so flicking between
 * tabs does not fill the back button with steps nobody wants to retrace.
 */
const TABS = ['folders', 'processing', 'access', 'license'] as const;
type SettingsTab = (typeof TABS)[number];

const route = useRoute();
const router = useRouter();

function readTab(value: unknown): SettingsTab {
  return TABS.includes(value as SettingsTab) ? (value as SettingsTab) : 'folders';
}

const tab = computed({
  get: () => readTab(route.query.tab),
  set: (value: SettingsTab) => {
    void router.replace({ query: { ...route.query, tab: value } });
  },
});

const settings = ref<AppSettings | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);
const desktop = useDesktopBridge();

const saved = ref(false);
const browsing = ref(false);

async function load(): Promise<void> {
  settings.value = await settingsApi.get();
}

async function save(patch: Partial<AppSettings>): Promise<void> {
  saving.value = true;
  error.value = null;
  saved.value = false;
  try {
    settings.value = await settingsApi.update(patch);
    saved.value = true;
  } catch (caught) {
    error.value = caught instanceof ApiRequestError ? caught.message : t('errors.saveFailed');
    // Reload so the form never shows a value the server rejected.
    await load();
  } finally {
    saving.value = false;
  }
}

function addFolder(path: string): void {
  const current = settings.value?.folderAllowlist ?? [];
  if (!current.includes(path)) {
    void save({ folderAllowlist: [...current, path] });
  }
}

function removeFolder(path: string): void {
  const current = settings.value?.folderAllowlist ?? [];
  void save({ folderAllowlist: current.filter((item) => item !== path) });
}

function changeLocale(value: AppLocale): void {
  setLocale(value);
  void save({ locale: value });
}

onMounted(load);
</script>

<template>
  <div class="settings">
    <h1 class="settings__title">{{ t('nav.settings') }}</h1>

    <v-alert v-if="error" type="error" density="compact" class="mb-4">{{ error }}</v-alert>
    <v-alert v-else-if="saved" type="success" density="compact" class="mb-4">
      {{ t('settings.saved') }}
    </v-alert>

    <!-- Tabs rather than one long scroll. The page had grown to six unrelated cards, and the
         licence - which someone looks for under Settings, not under System - was on another
         page entirely. Grouped by what the reader came to do, not by which service owns the
         value. -->
    <v-tabs v-model="tab" class="mb-4" color="primary">
      <v-tab value="folders">{{ t('settings.tabFolders') }}</v-tab>
      <v-tab value="processing">{{ t('settings.tabProcessing') }}</v-tab>
      <v-tab value="access">{{ t('settings.tabAccess') }}</v-tab>
      <v-tab value="license">{{ t('settings.tabLicense') }}</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <v-window-item value="folders">
        <!-- Folder allowlist -->
        <v-card class="pa-5 mb-4">
          <h2 class="text-h6 mb-1">{{ t('settings.allowlist') }}</h2>
          <p class="text-body-2 text-medium-emphasis mb-4">{{ t('settings.allowlistHint') }}</p>

          <div v-if="(settings?.folderAllowlist.length ?? 0) === 0" class="ocr-alert-warning mb-4">
            {{ t('settings.allowlistEmpty') }}
          </div>

          <v-list v-else density="compact" class="mb-3 py-0">
            <v-list-item
              v-for="folder in settings?.folderAllowlist ?? []"
              :key="folder"
              rounded="md"
            >
              <template #prepend>
                <v-icon icon="folder" size="20" color="primary" />
              </template>
              <v-list-item-title class="ocr-mono">{{ folder }}</v-list-item-title>
              <template #append>
                <v-btn
                  icon="cancel"
                  size="small"
                  variant="text"
                  :title="t('common.delete')"
                  @click="removeFolder(folder)"
                />
              </template>
            </v-list-item>
          </v-list>

          <v-btn prepend-icon="create_new_folder" variant="tonal" @click="browsing = true">
            {{ t('settings.addFolder') }}
          </v-btn>

          <!-- `system` scope: choosing what to authorise must be able to see outside the
             allowlist. The server only permits this on loopback or with auth enabled. -->
          <FolderBrowserDialog
            v-model="browsing"
            scope="system"
            :title="t('settings.addFolder')"
            @select="addFolder"
          />
        </v-card>
      </v-window-item>

      <v-window-item value="processing">
        <!-- How the Accurate profile is driven. Not a quality setting: the same model either way,
           so the only thing on offer here is speed and whether a CPU can run it at all. -->
        <v-card v-if="settings" class="pa-5 mb-4">
          <h2 class="text-h6 mb-4">{{ t('settings.engineTitle') }}</h2>

          <v-switch
            :model-value="settings.vlBackend === 'llama-cpp'"
            :label="t('settings.vlBackend')"
            :hint="t('settings.vlBackendHint')"
            persistent-hint
            color="primary"
            density="compact"
            class="mb-6"
            @update:model-value="save({ vlBackend: $event === true ? 'llama-cpp' : 'native' })"
          />

          <v-slider
            v-if="settings.vlBackend === 'llama-cpp'"
            :model-value="settings.vlConcurrency"
            :min="1"
            :max="16"
            :step="1"
            thumb-label
            :label="t('settings.vlConcurrency')"
            :hint="t('settings.vlConcurrencyHint')"
            persistent-hint
            @end="save({ vlConcurrency: Number($event) })"
          >
            <template #append>
              <span class="settings__value ocr-mono">{{ settings.vlConcurrency }}</span>
            </template>
          </v-slider>
        </v-card>

        <!-- Resource use. The defaults are chosen so the machine stays usable during a run. -->
        <v-card v-if="settings" class="pa-5 mb-4">
          <h2 class="text-h6 mb-4">{{ t('settings.resourcesTitle') }}</h2>

          <v-slider
            :model-value="settings.cpuBudgetPercent"
            :min="10"
            :max="100"
            :step="10"
            thumb-label
            :label="t('settings.cpuBudget')"
            :hint="t('settings.cpuBudgetHint')"
            persistent-hint
            class="mb-6"
            @end="save({ cpuBudgetPercent: Number($event) })"
          >
            <template #append>
              <span class="settings__value ocr-mono">{{ settings.cpuBudgetPercent }}%</span>
            </template>
          </v-slider>

          <v-slider
            :model-value="settings.maxConcurrentDocuments"
            :min="1"
            :max="8"
            :step="1"
            thumb-label
            :label="t('settings.concurrency')"
            :hint="t('settings.concurrencyHint')"
            persistent-hint
            class="mb-6"
            @end="save({ maxConcurrentDocuments: Number($event) })"
          >
            <template #append>
              <span class="settings__value ocr-mono">{{ settings.maxConcurrentDocuments }}</span>
            </template>
          </v-slider>

          <!-- Minutes, not a slider: the useful values span 1 to a working day, which no slider
             resolves sensibly, and 0 has to be typeable because it means "never". -->
          <v-text-field
            :model-value="settings.sidecarIdleMinutes"
            type="number"
            :min="0"
            :max="1440"
            :label="t('settings.sidecarIdle')"
            :hint="t('settings.sidecarIdleHint')"
            persistent-hint
            @update:model-value="save({ sidecarIdleMinutes: Number($event) })"
          />
        </v-card>
      </v-window-item>

      <v-window-item value="access">
        <v-card v-if="settings" class="pa-5 mb-4">
          <h2 class="text-h6 mb-4">{{ t('settings.server') }}</h2>

          <v-text-field
            :model-value="settings.port"
            type="number"
            :label="t('settings.port')"
            :hint="t('settings.restartRequired')"
            persistent-hint
            class="mb-4"
            @update:model-value="save({ port: Number($event) })"
          />

          <v-select
            :model-value="settings.bindAddress"
            :items="[
              { value: '127.0.0.1', title: t('settings.bindLocal') },
              { value: '0.0.0.0', title: t('settings.bindNetwork') },
            ]"
            :label="t('settings.bindAddress')"
            :hint="t('settings.restartRequired')"
            persistent-hint
            class="mb-4"
            @update:model-value="save({ bindAddress: $event })"
          />

          <v-select
            :model-value="settings.scheme"
            :items="[
              { value: 'http', title: t('settings.schemeHttp') },
              { value: 'https', title: t('settings.schemeHttps') },
            ]"
            :label="t('settings.scheme')"
            :hint="t('settings.schemeHint')"
            persistent-hint
            class="mb-4"
            @update:model-value="save({ scheme: $event })"
          />

          <v-switch
            :model-value="settings.authEnabled"
            :label="t('settings.auth')"
            color="primary"
            density="compact"
            :hint="t('settings.authHint')"
            persistent-hint
            @update:model-value="save({ authEnabled: Boolean($event) })"
          />

          <v-alert
            v-if="settings.bindAddress !== '127.0.0.1'"
            type="warning"
            variant="tonal"
            density="compact"
            class="mt-4"
          >
            {{ t('settings.networkRequirements') }}
          </v-alert>
        </v-card>

        <!-- Server -->
        <!-- Only in the desktop app: the main process is the sole reader, and a browser against
           the headless server has neither a window nor a tray to describe. -->
        <v-card v-if="settings && desktop.isDesktop.value" class="pa-5 mb-4">
          <h2 class="text-h6 mb-1">{{ t('settings.desktop') }}</h2>
          <p class="text-body-2 text-medium-emphasis mb-4">{{ t('settings.desktopHint') }}</p>

          <v-switch
            :model-value="settings.startMinimizedToTray"
            :label="t('settings.startMinimizedToTray')"
            :hint="t('settings.startMinimizedToTrayHint')"
            persistent-hint
            color="primary"
            density="compact"
            @update:model-value="save({ startMinimizedToTray: $event === true })"
          />
        </v-card>

        <PasswordCard @changed="load" />
      </v-window-item>

      <!-- The licence lives here rather than on System. System is about this machine's
           hardware and runtime; a licence is an account-level thing people go to Settings
           looking for. -->
      <v-window-item value="license">
        <LicenseCard />
      </v-window-item>
    </v-window>

    <!-- Outside the tabs: appearance and data retention apply to the whole application, and
         hiding them behind one tab makes them hard to find again. -->
    <!-- Appearance & data -->
    <v-card v-if="settings" class="pa-5">
      <h2 class="text-h6 mb-4">{{ t('settings.appearance') }}</h2>

      <v-select
        :model-value="locale"
        :items="[
          { value: 'en', title: 'English' },
          { value: 'de', title: 'Deutsch' },
        ]"
        :label="t('settings.language')"
        class="mb-4"
        @update:model-value="changeLocale($event as AppLocale)"
      />

      <v-text-field
        :model-value="settings.historyRetentionDays"
        type="number"
        :label="t('settings.retention')"
        :hint="t('settings.retentionHint')"
        persistent-hint
        @update:model-value="save({ historyRetentionDays: Number($event) })"
      />
    </v-card>

    <v-progress-linear v-if="saving" indeterminate color="primary" class="mt-4" />
  </div>
</template>

<style scoped>
/* A fixed minimum width, so the slider track does not jump left and right by a few pixels as
   the number gains or loses a digit while being dragged. */
.settings__value {
  min-width: 3.25rem;
  text-align: right;
  font-size: 0.875rem;
  opacity: 0.75;
}

.settings {
  max-width: 760px;
}

.settings__title {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 28px;
  font-weight: 500;
  margin: 0 0 24px;
}
</style>
