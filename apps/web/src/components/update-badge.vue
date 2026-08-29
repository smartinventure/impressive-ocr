<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppUpdate } from '../composables/use-app-update';

/**
 * "There is a newer version", where someone will see it.
 *
 * The main process has always checked on start and on an interval, but the only surface was a
 * card on the System page -- a page nobody visits when nothing is wrong. So a release could sit
 * available indefinitely with the application never mentioning it.
 *
 * Silent unless there is something to say: no badge while up to date, while checking, or on a
 * failed check. An indicator that is always present is one nobody reads.
 *
 * The state comes from `use-app-update` rather than a local ref. This component, the card on
 * the System page and the dashboard notice all describe the same fact, and a copy each meant
 * three subscriptions to the main process and three checks on load.
 *
 * Renders nothing in a browser. The headless server is updated by whatever installed it, and
 * offering its users an update they cannot apply would be worse than saying nothing.
 */

const { t } = useI18n();
const update = useAppUpdate();

onMounted(() => {
  update.watch();
  // The main process checks at startup, and that event may have fired before this existed;
  // asking once covers a window the subscription cannot.
  void update.check();
});
onUnmounted(update.unwatch);

/** `ready` too: downloaded but not installed still needs the user to act. */
const show = computed(
  () => update.status.value.state === 'available' || update.status.value.state === 'ready',
);

const label = computed(() =>
  update.status.value.state === 'ready' ? t('updateBadge.ready') : t('updateBadge.available'),
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
      {{ t('updateBadge.tooltip', { version: update.status.value.version ?? '' }) }}
    </v-tooltip>
  </v-chip>
</template>

<style scoped>
.update-badge {
  /* Sits with the connection chip; the footer stacks, so it needs its own breathing room. */
  margin-top: 0.5rem;
}
</style>
