<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PreflightCheck } from '@impressive-ocr/shared';
import { systemApi } from '../api/endpoints';

/**
 * Says on the dashboard whether this machine can run the engine, and what is missing.
 *
 * It belongs here rather than only on the System page because the answer decides whether
 * anything else on the screen means anything, and nobody visits System until something has
 * already gone wrong. A machine that cannot run the engine should say so before the user
 * spends an afternoon concluding the application is broken.
 *
 * Fetched once on mount, deliberately **not** joined to the dashboard's four-second poll:
 * the CPU probe spawns a shell, and the answer does not change while you watch it.
 */

const { t } = useI18n();

const checks = ref<PreflightCheck[]>([]);
const canInstall = ref(true);

const blocked = computed(() => checks.value.filter((check) => check.severity === 'blocked'));
const fixable = computed(() => checks.value.filter((check) => check.severity === 'fixable'));

/** Nothing to say when everything passes. A banner that is always there stops being read. */
const visible = computed(() => blocked.value.length > 0 || fixable.value.length > 0);

onMounted(async () => {
  try {
    const report = await systemApi.preflight();
    checks.value = report.checks;
    canInstall.value = report.canInstall;
  } catch {
    // Silent: the System page owns the "the check itself failed" message. Shouting about a
    // failed probe on the dashboard would be noise on every disconnect.
    checks.value = [];
  }
});
</script>

<template>
  <v-alert
    v-if="visible"
    :type="blocked.length > 0 ? 'error' : 'warning'"
    variant="tonal"
    density="compact"
    class="mb-4"
  >
    <p class="mb-1 font-weight-medium">
      {{ blocked.length > 0 ? t('preflight.cannotRun') : t('preflight.actionNeeded') }}
    </p>

    <p v-for="item in blocked" :key="item.id" class="mb-1 text-body-2">{{ item.detail }}</p>

    <!-- Fixable items are summarised, not spelled out: the steps live on the System page,
         which is also where the install button is. -->
    <p v-for="item in fixable" :key="item.id" class="mb-1 text-body-2">
      {{ item.title }} — {{ item.remedy?.summary ?? item.detail }}
    </p>

    <RouterLink :to="{ name: 'system' }" class="compatibility__link">
      {{ t('preflight.openSystem') }}
    </RouterLink>
  </v-alert>
</template>

<style scoped>
.compatibility__link {
  display: inline-block;
  margin-top: 6px;
  font-size: 13px;
  font-weight: 500;
  color: inherit;
}
</style>
