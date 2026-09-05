<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useServerUpdate } from '../composables/use-server-update';

/**
 * "A new version is available" for the headless server, and the dialog that applies it.
 *
 * Shown only in a browser. The desktop app has its own badge driven by electron-updater, and
 * `useServerUpdate` refuses to check at all when the Electron bridge is present.
 *
 * The dialog states the downtime before offering the button, rather than after. Applying an
 * update stops and recreates the container: any job running at that moment is interrupted,
 * and on a machine that watches folders unattended that is a real cost someone should be able
 * to decline. The button is not the default action for the same reason.
 */

const { t } = useI18n();
const update = useServerUpdate();
const dialogOpen = ref(false);

onMounted(() => {
  void update.check();
});
</script>

<template>
  <div v-if="update.updateAvailable.value || update.pending.value" class="server-update">
    <div class="ocr-alert-info server-update__banner">
      <span class="server-update__text">
        <template v-if="update.pending.value">
          {{ t('serverUpdate.pending') }}
        </template>
        <template v-else>
          {{
            t('serverUpdate.available', {
              current: update.status.value?.currentVersion ?? '',
              latest: update.latestVersion.value ?? '',
            })
          }}
        </template>
      </span>

      <VBtn
        v-if="!update.pending.value"
        class="server-update__action"
        variant="text"
        size="small"
        @click="dialogOpen = true"
      >
        {{ t('serverUpdate.review') }}
      </VBtn>
    </div>

    <VDialog v-model="dialogOpen" max-width="560">
      <VCard>
        <VCardTitle>{{ t('serverUpdate.dialogTitle') }}</VCardTitle>

        <VCardText>
          <p class="mb-3">
            {{
              t('serverUpdate.dialogVersions', {
                current: update.status.value?.currentVersion ?? '',
                latest: update.latestVersion.value ?? '',
              })
            }}
          </p>

          <a
            v-if="update.releaseNotesUrl.value !== null"
            class="server-update__notes"
            :href="update.releaseNotesUrl.value"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t('serverUpdate.releaseNotes') }}
          </a>

          <!-- Stated before the button, not after it. -->
          <div class="ocr-alert-warning my-4">
            {{ t('serverUpdate.downtimeWarning') }}
          </div>

          <!-- No host updater: the command to run by hand, ready to copy. -->
          <template v-if="!update.canApplyFromHere.value">
            <p class="mb-2">{{ t('serverUpdate.manualIntro') }}</p>
            <pre class="server-update__command">{{ update.status.value?.updateCommand }}</pre>
            <p class="server-update__hint">
              {{ t('serverUpdate.installerHint') }}
            </p>
          </template>
        </VCardText>

        <VCardActions>
          <VSpacer />
          <VBtn variant="text" @click="dialogOpen = false">
            {{ t('common.close') }}
          </VBtn>
          <VBtn
            v-if="update.canApplyFromHere.value"
            color="primary"
            variant="flat"
            :loading="update.triggering.value"
            @click="update.applyUpdate()"
          >
            {{ t('serverUpdate.applyNow') }}
          </VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
  </div>
</template>

<style scoped>
.server-update__banner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.server-update__text {
  flex: 1;
}

.server-update__command {
  padding: 12px;
  border-radius: 4px;
  background: rgb(var(--v-theme-surface-variant));
  font-family: var(--ocr-font-mono, monospace);
  font-size: 0.85rem;
  /* A long command must scroll rather than widen the dialog. */
  overflow-x: auto;
  white-space: pre;
}

.server-update__hint {
  margin-top: 8px;
  font-size: 0.8rem;
  opacity: 0.75;
}

.server-update__notes {
  font-size: 0.9rem;
}
</style>
