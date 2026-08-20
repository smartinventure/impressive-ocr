<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from 'vuetify';
import { useI18n } from 'vue-i18n';
import { statusSurfaces, type StatusKey } from '../plugins/theme';

/**
 * The status indicator, used everywhere a pipeline or job state appears.
 *
 * Colour is never the only signal: every chip carries an icon and a text label, so the six
 * states stay distinguishable for colour-blind users and in a screenshot pasted into a
 * support ticket.
 */

const props = withDefaults(
  defineProps<{
    status: StatusKey;
    count?: number | null;
    /** Compact form for dense tables — icon and label only. */
    dense?: boolean;
  }>(),
  { count: null, dense: false },
);

const theme = useTheme();
const { t } = useI18n();

const ICONS: Record<StatusKey, string> = {
  queued: 'schedule',
  running: 'play_arrow',
  paused: 'pause',
  succeeded: 'check_circle',
  failed: 'error',
  quarantined: 'shield',
};

const surface = computed(() => {
  const palette = theme.current.value.dark ? statusSurfaces.dark : statusSurfaces.light;
  return palette[props.status];
});

const foreground = computed(() => theme.current.value.colors[props.status] ?? 'currentColor');
const label = computed(() => t(`status.${props.status}`));
</script>

<template>
  <span
    class="status-chip"
    :class="{ 'status-chip--dense': dense }"
    :style="{
      background: surface.bg,
      borderColor: surface.border,
      color: foreground,
    }"
  >
    <span class="material-symbols-rounded status-chip__icon" aria-hidden="true">
      {{ ICONS[status] }}
    </span>
    <span class="status-chip__label">{{ label }}</span>
    <span v-if="count !== null" class="status-chip__count">{{ count }}</span>
  </span>
</template>

<style scoped>
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 12px 5px 9px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  /* Long German labels must not force a chip to wrap mid-word. */
  white-space: nowrap;
}

.status-chip--dense {
  padding: 3px 9px 3px 7px;
  font-size: 12px;
  gap: 5px;
}

.status-chip__icon {
  font-size: 18px;
  line-height: 1;
}

.status-chip--dense .status-chip__icon {
  font-size: 15px;
}

.status-chip__count {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  opacity: 0.7;
}
</style>
