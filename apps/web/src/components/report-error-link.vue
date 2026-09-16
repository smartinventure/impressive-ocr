<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ISSUES_URL } from '@impressive-ocr/shared';

/**
 * A way to report a problem, from wherever the problem happened.
 *
 * In the drawer rather than on a help page, because the moment someone wants this is the
 * moment something went wrong — and asking them to go and find the reporting link first is
 * how a report turns into a shrug.
 *
 * An ordinary link with `target="_blank"`. In a browser that is simply a new tab; inside
 * Electron the main window's `setWindowOpenHandler` denies a second Electron window and
 * passes http(s) to `shell.openExternal`, so it opens the user's real browser. Nothing
 * app-specific is needed here, and deliberately so: a component that reached for an Electron
 * API would stop working in the browser against the headless server, where the same page is
 * served.
 */

const { t } = useI18n();
</script>

<template>
  <a
    class="report"
    :href="ISSUES_URL"
    target="_blank"
    rel="noopener noreferrer"
    :title="t('report.hint')"
  >
    <v-icon icon="mdi-bug-outline" size="small" />
    <span>{{ t('report.label') }}</span>
  </a>
</template>

<style scoped>
/*
 * Lighter than the donation button directly above it.
 *
 * Same shape, so the two read as a pair, but drawn in the muted outline tone rather than the
 * error colour: reporting a bug is useful and occasional, and it should not compete with
 * navigation — or shout louder than the ask it sits under.
 */
.report {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 7px 10px;
  border: 1px solid rgb(var(--v-theme-on-surface) / 0.22);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  text-align: center;
  text-decoration: none;
  /* Deliberately not full strength: this is a quiet offer, not a call to action. */
  color: rgb(var(--v-theme-on-surface) / 0.75);
}

.report:hover {
  border-color: rgb(var(--v-theme-on-surface) / 0.4);
  background: rgb(var(--v-theme-on-surface) / 0.05);
  color: rgb(var(--v-theme-on-surface));
}
</style>
