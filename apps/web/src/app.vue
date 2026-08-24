<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { useTheme } from 'vuetify';
import { APP_VERSION } from '@impressive-ocr/shared';
import { useLiveStore } from './stores/live-store';
import UpdateBadge from './components/update-badge.vue';
import { darkExtras, extrasToCssVariables, lightExtras } from './plugins/theme';
import { setLocale, type AppLocale } from './plugins/i18n';

/**
 * The application shell: navigation rail, top bar, and the single event-stream subscription.
 */

/**
 * Fixed, not `new Date().getFullYear()`.
 *
 * A copyright year should state when the work was published, and deriving it from the clock
 * silently rewrites that claim on every machine the app runs on -- including backwards, if a
 * user's system date is wrong.
 */
const COPYRIGHT_YEAR = 2026;

const store = useLiveStore();
const route = useRoute();
const theme = useTheme();

/** The login screen stands alone: no navigation to offer someone who cannot use it yet. */
const showChrome = computed(() => route.name !== 'login');
const { t, locale } = useI18n();

const nav = computed(() => [
  // Dashboard first: what the machine is doing and what it has got through. Quick Mode
  // next, being the shortest path to an actual result.
  { to: { name: 'dashboard' }, icon: 'dashboard', label: t('nav.dashboard') },
  { to: { name: 'quick' }, icon: 'bolt', label: t('nav.quick') },
  { to: { name: 'pipelines' }, icon: 'account_tree', label: t('nav.pipelines') },
  { to: { name: 'jobs' }, icon: 'history', label: t('nav.jobs') },
  { to: { name: 'system' }, icon: 'monitor_heart', label: t('nav.status') },
  { to: { name: 'logs' }, icon: 'terminal', label: t('nav.logs') },
  { to: { name: 'settings' }, icon: 'settings', label: t('nav.settings') },
]);

const connectionColour = computed(() => {
  switch (store.connection) {
    case 'open':
      return 'succeeded';
    case 'reconnecting':
      return 'paused';
    default:
      return 'queued';
  }
});

/**
 * Publish the non-Vuetify tokens as CSS variables on the root element.
 *
 * Vuetify only owns its own colour slots; the alert washes and muted text live outside them
 * and would otherwise have to be hard-coded per component — exactly what the design system
 * exists to prevent.
 */
function applyExtras(): void {
  const extras = theme.current.value.dark ? darkExtras : lightExtras;
  for (const [name, value] of Object.entries(extrasToCssVariables(extras))) {
    document.documentElement.style.setProperty(name, value);
  }
}

watch(() => theme.current.value.dark, applyExtras, { immediate: true });

function toggleTheme(): void {
  theme.change(theme.current.value.dark ? 'light' : 'dark');
}

function switchLocale(): void {
  setLocale(locale.value === 'en' ? 'de' : ('en' as AppLocale));
}

onMounted(() => {
  applyExtras();
  if (showChrome.value) store.start();
});

// Starting the stream while signed out would just produce 401s; start it once the user is
// past the login screen, and stop it if they return there.
watch(showChrome, (visible) => {
  if (visible) store.start();
  else store.stop();
});

onBeforeUnmount(() => store.stop());
</script>

<template>
  <v-app>
    <v-navigation-drawer v-if="showChrome" permanent width="232" color="surface" border="0">
      <div class="shell__brand">
        <div class="shell__mark" aria-hidden="true">
          <span></span><span></span><span class="shell__mark-short"></span
          ><span class="shell__mark-tail"></span>
        </div>
        <div class="shell__wordmark">
          <span class="shell__wordmark-light">Impressive</span
          ><span class="shell__wordmark-bold">OCR</span>
        </div>
      </div>

      <v-list nav class="px-2">
        <v-list-item
          v-for="item in nav"
          :key="item.icon"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.label"
          rounded="md"
          color="primary"
        />
      </v-list>

      <template #append>
        <div class="shell__footer">
          <v-chip size="small" variant="tonal" :color="connectionColour" label>
            {{ t(`connection.${store.connection}`) }}
          </v-chip>

          <!-- Beside the version it refers to, and silent unless there is an update. -->
          <UpdateBadge />

          <div class="shell__colophon">
            <span>&copy; Smart In Venture {{ COPYRIGHT_YEAR }}</span>
            <a
              class="shell__link"
              href="https://www.speedbits.io"
              target="_blank"
              rel="noopener noreferrer"
              >www.speedbits.io</a
            >
            <span class="shell__version">v{{ APP_VERSION }}</span>
          </div>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar v-if="showChrome" flat height="60" color="surface" border="b">
      <v-spacer />
      <v-btn
        :icon="theme.current.value.dark ? 'light_mode' : 'dark_mode'"
        variant="text"
        size="small"
        @click="toggleTheme"
      />
      <v-btn variant="text" size="small" class="mr-2" @click="switchLocale">
        {{ locale.toUpperCase() }}
      </v-btn>
    </v-app-bar>

    <v-main>
      <div :class="showChrome ? 'shell__content' : ''">
        <router-view />
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.shell__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 18px 14px;
}

/* The mark, rebuilt in CSS: four text bars with the fourth broken in two — the brand idea
   is that break, so it must survive at any size rather than being an image that blurs. */
.shell__mark {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: rgb(var(--v-theme-primary));
  flex: none;
}

.shell__mark span {
  position: absolute;
  left: 7.5px;
  height: 3px;
  width: 19px;
  background: rgb(var(--v-theme-on-primary));
}

.shell__mark span:nth-child(1) {
  top: 9.5px;
}
.shell__mark span:nth-child(2) {
  top: 15.3px;
}
.shell__mark-short {
  top: 21.1px;
  width: 11.5px !important;
}
.shell__mark-tail {
  top: 21.1px;
  left: 21.7px !important;
  width: 4.7px !important;
}

.shell__wordmark {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 19px;
  letter-spacing: -0.6px;
  color: rgb(var(--v-theme-on-surface));
  line-height: 1;
}

.shell__wordmark-light {
  font-weight: 400;
}
.shell__wordmark-bold {
  font-weight: 700;
}

.shell__footer {
  padding: 14px 18px;
}

.shell__colophon {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
  /* Deliberately quiet: this is provenance, not navigation. */
  font-size: 0.6875rem;
  line-height: 1.45;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.55;
}

.shell__link {
  color: inherit;
  text-decoration: none;
}

.shell__link:hover {
  text-decoration: underline;
}

.shell__version {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.shell__content {
  max-width: 1280px;
  margin: 0 auto;
  padding: 28px 32px 64px;
}
</style>
