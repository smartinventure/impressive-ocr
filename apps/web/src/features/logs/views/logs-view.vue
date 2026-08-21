<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { logsApi } from '../../../api/endpoints';

/**
 * The application log, as a terminal.
 *
 * Deliberately raw. Someone debugging a pipeline that quarantines every document needs the
 * actual records, not a prettified summary that has already decided what matters — and the
 * desktop build gives them no other way to see them at all.
 */

interface LogLine {
  level: number;
  time: string;
  message: string;
  raw: string;
}

const { t } = useI18n();

const lines = ref<LogLine[]>([]);
const truncated = ref(false);
const totalBytes = ref(0);
const busy = ref(false);
const error = ref<string | null>(null);
const follow = ref(true);
const filter = ref('');
const viewport = ref<HTMLElement | null>(null);

/** Often enough to feel live next to an OCR run, rare enough to cost nothing. */
const POLL_INTERVAL_MS = 3000;

let timer: ReturnType<typeof setInterval> | undefined;

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (needle === '') return lines.value;
  // Match the raw record, not the rendered message: the useful detail is usually in the
  // fields — a job id, a path, an error code — rather than in the sentence.
  return lines.value.filter((line) => line.raw.toLowerCase().includes(needle));
});

const sizeLabel = computed(() => `${(totalBytes.value / 1024 / 1024).toFixed(2)} MB`);

const errorCount = computed(() => lines.value.filter((line) => line.level >= 50).length);

/**
 * Parse one pino record into something readable.
 *
 * Falls back to the raw text. A Python traceback forwarded from the sidecar is not JSON, and
 * dropping it would hide exactly the failures this page exists for.
 */
function parseLine(raw: string): LogLine {
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const stamp = typeof record.time === 'number' ? new Date(record.time).toISOString() : '';
    return {
      level: typeof record.level === 'number' ? record.level : 30,
      time: stamp.length > 0 ? stamp.slice(11, 23) : '',
      message: typeof record.msg === 'string' ? record.msg : raw,
      raw,
    };
  } catch {
    return { level: 30, time: '', message: raw, raw };
  }
}

function levelClass(level: number): string {
  if (level >= 50) return 'logs__line--error';
  if (level >= 40) return 'logs__line--warn';
  if (level <= 20) return 'logs__line--debug';
  return '';
}

async function refresh(): Promise<void> {
  try {
    const result = await logsApi.tail();
    lines.value = result.text.split('\n').filter(Boolean).map(parseLine);
    truncated.value = result.truncated;
    totalBytes.value = result.totalBytes;
    error.value = null;

    if (follow.value) {
      await nextTick();
      scrollToEnd();
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : t('logs.loadFailed');
  }
}

function scrollToEnd(): void {
  const element = viewport.value;
  if (element !== null) element.scrollTop = element.scrollHeight;
}

async function clear(): Promise<void> {
  busy.value = true;
  try {
    await logsApi.clear();
    await refresh();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : t('logs.clearFailed');
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await refresh();
  timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <div class="logs">
    <header class="logs__header">
      <div>
        <h1 class="logs__title">{{ t('nav.logs') }}</h1>
        <p class="text-body-2 text-medium-emphasis">{{ t('logs.subtitle') }}</p>
      </div>
    </header>

    <div class="d-flex ga-3 flex-wrap align-center mb-3">
      <v-text-field
        v-model="filter"
        :label="t('logs.filter')"
        density="compact"
        variant="outlined"
        hide-details
        prepend-inner-icon="search"
        clearable
        style="max-width: 320px"
      />
      <v-switch
        v-model="follow"
        :label="t('logs.follow')"
        color="primary"
        density="compact"
        hide-details
      />
      <v-spacer />
      <v-chip v-if="errorCount > 0" size="small" color="failed" variant="tonal" label>
        {{ t('logs.errorCount', { count: errorCount }) }}
      </v-chip>
      <span class="text-caption text-medium-emphasis">{{ sizeLabel }}</span>
      <v-btn size="small" variant="text" prepend-icon="delete" :loading="busy" @click="clear">
        {{ t('logs.clear') }}
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>

    <v-alert v-if="truncated" type="info" variant="tonal" density="compact" class="mb-3">
      {{ t('logs.truncated') }}
    </v-alert>

    <div ref="viewport" class="logs__viewport">
      <p v-if="visible.length === 0" class="logs__empty">{{ t('logs.empty') }}</p>
      <div
        v-for="(line, index) in visible"
        :key="index"
        class="logs__line"
        :class="levelClass(line.level)"
      >
        <span class="logs__time">{{ line.time }}</span>
        <span class="logs__message">{{ line.message }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logs__header {
  margin-bottom: 16px;
}

.logs__title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

/* A terminal, deliberately: fixed palette rather than theme tokens, because this is machine
   output and reads best the way machine output has always read. */
.logs__viewport {
  height: calc(100vh - 280px);
  min-height: 320px;
  overflow-y: auto;
  background: #0d1117;
  border-radius: 8px;
  padding: 12px 14px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.55;
}

.logs__line {
  display: flex;
  gap: 12px;
  color: #c9d1d9;
  white-space: pre-wrap;
  word-break: break-word;
}

.logs__time {
  color: #6e7681;
  flex: none;
}

.logs__message {
  flex: 1;
}

.logs__line--error .logs__message {
  color: #ff7b72;
}

.logs__line--warn .logs__message {
  color: #d29922;
}

.logs__line--debug .logs__message {
  color: #8b949e;
}

.logs__empty {
  color: #6e7681;
}
</style>
