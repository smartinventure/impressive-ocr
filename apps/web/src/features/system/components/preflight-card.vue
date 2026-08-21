<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PreflightCheck, PreflightSeverity } from '@impressive-ocr/shared';
import { systemApi } from '../../../api/endpoints';

/**
 * Whether this machine can run the OCR engine, before anything is downloaded.
 *
 * The two severities carry very different meanings and must not look alike: `fixable` is one
 * download away, `blocked` is a machine that will never run the engine no matter what is
 * installed. A user who reads the second as the first will keep trying.
 */

const { t } = useI18n();

const checks = ref<PreflightCheck[]>([]);
const canInstall = ref(true);
const loading = ref(false);
const failed = ref(false);

const blocked = computed(() => checks.value.filter((check) => check.severity === 'blocked'));
const hasRun = computed(() => checks.value.length > 0);

const ICONS: Record<PreflightSeverity, string> = {
  ok: 'check_circle',
  fixable: 'warning',
  blocked: 'cancel',
};

const COLORS: Record<PreflightSeverity, string> = {
  ok: 'succeeded',
  fixable: 'running',
  blocked: 'failed',
};

async function check(): Promise<void> {
  loading.value = true;
  failed.value = false;
  try {
    const report = await systemApi.preflight();
    checks.value = report.checks;
    canInstall.value = report.canInstall;
  } catch {
    // A probe that cannot run tells the user nothing useful about their CPU; say so rather
    // than rendering an empty list that reads as "all clear".
    failed.value = true;
    checks.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(check);
</script>

<template>
  <v-card class="pa-5 mb-4">
    <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-3">
      <h2 class="text-h6">{{ t('preflight.title') }}</h2>
      <v-btn size="small" variant="text" prepend-icon="refresh" :loading="loading" @click="check">
        {{ t('preflight.recheck') }}
      </v-btn>
    </div>

    <p v-if="failed" class="text-body-2 text-medium-emphasis">{{ t('preflight.probeFailed') }}</p>

    <!-- The verdict first. On a machine that cannot run the engine this is the only thing
         most users need to read, so it must not sit below a list of green ticks. -->
    <div v-else-if="hasRun && !canInstall" class="ocr-alert-error mb-4">
      <strong>{{ t('preflight.cannotRun') }}</strong>
      <p v-for="item in blocked" :key="item.id" class="mb-0 mt-1">{{ item.detail }}</p>
    </div>

    <ul v-if="hasRun" class="preflight__list">
      <li v-for="item in checks" :key="item.id" class="preflight__item">
        <v-icon :icon="ICONS[item.severity]" :color="COLORS[item.severity]" size="20" />
        <div class="preflight__body">
          <p class="preflight__name">{{ item.title }}</p>
          <p class="preflight__detail">{{ item.detail }}</p>

          <div v-if="item.remedy" class="preflight__remedy">
            <p class="preflight__summary">{{ item.remedy.summary }}</p>
            <ol class="preflight__steps">
              <li v-for="(step, index) in item.remedy.steps" :key="index">{{ step }}</li>
            </ol>
            <!-- Opened in the user's browser rather than fetched by us: downloading and
                 running an elevated installer is not something this app should do behind a
                 click, and the headless server could not elevate anyway. -->
            <a
              v-if="item.remedy.downloadUrl"
              :href="item.remedy.downloadUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="preflight__link"
            >
              {{ t('preflight.download') }}
            </a>
          </div>
        </div>
      </li>
    </ul>
  </v-card>
</template>

<style scoped>
.preflight__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 14px;
}

.preflight__item {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 10px;
  align-items: start;
}

.preflight__name {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.preflight__detail {
  margin: 2px 0 0;
  font-size: 13px;
  color: rgb(var(--v-theme-on-surface-variant));
}

.preflight__remedy {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgb(var(--v-theme-surface-variant));
}

.preflight__summary {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.preflight__steps {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: rgb(var(--v-theme-on-surface-variant));
}

.preflight__link {
  display: inline-block;
  margin-top: 8px;
  font-size: 13px;
}
</style>
