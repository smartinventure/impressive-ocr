<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { APP_VERSION } from '@impressive-ocr/shared';
import { useLiveStore } from '../stores/live-store';

/**
 * "Your OCR engine needs attention", in the one place that is always on screen.
 *
 * Both conditions it reports were previously visible only on the System page, which is
 * exactly the page someone with a working installation never opens. The fast inference
 * engine in particular is the difference between about 11 seconds and about five minutes a
 * page on the accurate profile, and an installation that predates it will never install it
 * on its own — so without this the app is quietly slow forever and nothing says why.
 *
 * No separate check on startup: `live-store` already loads the runtime status when the shell
 * mounts and keeps it current from the event stream, so this is a view of state that is
 * fetched anyway rather than another poll.
 */

const { t } = useI18n();
const store = useLiveStore();

/**
 * The fast inference engine is absent.
 *
 * Gated on `runtimeReady` so a runtime that is still installing — where this is true and
 * about to stop being true — does not flash a warning at someone who is already watching a
 * progress bar.
 */
const fastEngineMissing = computed(
  () => store.runtimeReady && store.runtime?.vlServerInstalled === false,
);

/**
 * The Python sidecar is older than the application.
 *
 * It is installed once and never updated automatically, so after an app update the two drift
 * apart and recognition improvements shipped with the new version are simply not present.
 */
const engineOutdated = computed(() => {
  const installed = store.runtime?.sidecarVersion ?? null;
  return store.runtimeReady && installed !== null && installed !== APP_VERSION;
});

/** Missing first: it costs far more than being a version behind. */
const message = computed(() => {
  if (fastEngineMissing.value) return t('engineNotice.fastMissing');
  if (engineOutdated.value) return t('engineNotice.outdated');
  return null;
});
</script>

<template>
  <!-- A link, not a toast: the condition persists until someone acts on it, and a
       notification that disappears on its own would be missed by exactly the people who
       never open the System page. -->
  <RouterLink v-if="message !== null" to="/system" class="engine-notice">
    <v-icon size="16" icon="mdi-lightning-bolt-outline" />
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
