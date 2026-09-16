<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEngineReadiness } from '../composables/use-engine-readiness';

/**
 * "Something needs installing", in the one place that is always on screen.
 *
 * What counts as missing lives in `use-engine-readiness`, shared with the dashboard banner so
 * the two cannot disagree. This file is the drawer's rendering of it and nothing more.
 *
 * No separate check on startup: `live-store` already loads the runtime status when the shell
 * mounts and keeps it current from the event stream, so this is a view of state that is
 * fetched anyway rather than another poll.
 */

const { t } = useI18n();
const { gap } = useEngineReadiness();

const message = computed(() => (gap.value === null ? null : t(`engineNotice.${gap.value}`)));
</script>

<template>
  <!-- A link, not a toast: the condition persists until someone acts on it, and a
       notification that disappears on its own would be missed by exactly the people who
       never open the System page. -->
  <RouterLink v-if="message !== null" to="/system" class="engine-notice">
    <v-icon size="16" icon="bolt" />
    <span>{{ message }}</span>
  </RouterLink>
</template>

<style scoped>
.engine-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  /* The warning tone rather than the error one. Nothing is broken: the app works, it is
     just slower or older than it could be. */
  background: rgb(var(--v-theme-warning), 0.12);
  border: 1px solid rgb(var(--v-theme-warning), 0.35);
  color: rgb(var(--v-theme-on-surface));
  font-size: 12px;
  line-height: 1.35;
  text-decoration: none;
}

.engine-notice:hover {
  background: rgb(var(--v-theme-warning), 0.2);
}
</style>
