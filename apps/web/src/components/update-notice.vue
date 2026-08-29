<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { APP_VERSION } from '@impressive-ocr/shared';
import { useAppUpdate } from '../composables/use-app-update';
import { useLiveStore } from '../stores/live-store';

/**
 * A line on the dashboard when something can be updated.
 *
 * Two different things, deliberately in one place. A new release of the application is the
 * user's decision and needs a restart; an OCR engine older than the build is not a decision at
 * all and now repairs itself at startup. What they share is that the dashboard is where
 * someone looks first, and neither was mentioned there.
 *
 * The engine half is a fallback rather than the main path. Since the sidecar is updated
 * automatically when the versions differ, seeing this means the automatic attempt failed --
 * so it points at the System page, where the manual repair lives and the error is shown.
 *
 * Links rather than acts. The buttons that download, install and repair are on the System
 * page, and duplicating them here would mean two places to keep correct.
 */

const { t } = useI18n();
const update = useAppUpdate();
const store = useLiveStore();

onMounted(update.watch);
onUnmounted(update.unwatch);

/**
 * The engine differs from the build.
 *
 * Null while nothing has reported a version yet: a runtime that has never been installed has
 * nothing to be out of date, and claiming otherwise would nag about an engine nobody has.
 */
const engineOutdated = computed(() => {
  const installed = store.runtime?.sidecarVersion ?? null;
  return installed !== null && installed !== APP_VERSION;
});

const visible = computed(() => update.updateAvailable.value || engineOutdated.value);
</script>

<template>
  <div v-if="visible" class="ocr-alert-info mb-4 update-notice">
    <span class="update-notice__text">
      <template v-if="update.updateAvailable.value">
        {{ t('update.noticeApp', { version: update.status.value.version ?? '' }) }}
      </template>
      <template v-else>
        {{ t('update.noticeEngine') }}
      </template>
    </span>

    <RouterLink class="update-notice__link" :to="{ name: 'system' }">
      {{ t('update.noticeAction') }}
    </RouterLink>
  </div>
</template>

<style scoped>
.update-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.update-notice__text {
  flex: 1 1 auto;
}

.update-notice__link {
  white-space: nowrap;
  font-weight: 600;
}
</style>
