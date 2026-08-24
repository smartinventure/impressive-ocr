<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useDesktopBridge, type UpdateStatus } from '../composables/use-desktop-bridge';

/**
 * "There is a newer version", where someone will see it.
 *
 * The main process has always checked on start and on an interval, but the only surface was a
 * card on the System page — a page nobody visits when nothing is wrong. So a release could sit
 * available indefinitely with the application never mentioning it.
 *
 * Silent unless there is something to say: no badge while up to date, while checking, or on a
 * failed check. An indicator that is always present is one nobody reads.
 *
 * Renders nothing in a browser. The headless server is updated by whatever installed it, and
 * offering its users an update they cannot apply would be worse than saying nothing.
 */

const { t } = useI18n();
const desktop = useDesktopBridge();

const status = ref<UpdateStatus | null>(null);
let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  if (!desktop.isDesktop.value) {
    return;
  }
  // Subscribe first: the main process checks at startup, and that event may already have
  // fired before this component existed.
  unsubscribe = desktop.onUpdateStatus((next) => {
    status.value = next;
  });
  status.value = await desktop.checkForUpdate();
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/** `ready` too: downloaded but not installed still needs the user to act. */
const show = computed(() => status.value?.state === 'available' || status.value?.state === 'ready');

const label = computed(() =>
  status.value?.state === 'ready' ? t('updateBadge.ready') : t('updateBadge.available'),
);
</script>

<template>
  <v-chip
    v-if="show"
    :to="{ name: 'system' }"
    size="small"
    variant="tonal"
    color="primary"
    prepend-icon="arrow_circle_up"
    label
    class="update-badge"
  >
    {{ label }}
    <v-tooltip activator="parent" location="top">
      {{ t('updateBadge.tooltip', { version: status?.version ?? '' }) }}
    </v-tooltip>
  </v-chip>
</template>

<style scoped>
.update-badge {
  /* Sits with the connection chip; the footer stacks, so it needs its own breathing room. */
  margin-top: 0.5rem;
}
</style>
