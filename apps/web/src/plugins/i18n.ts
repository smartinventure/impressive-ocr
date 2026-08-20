// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from 'vue-i18n';
import de from '../locales/de.json';
import en from '../locales/en.json';

/**
 * English and German.
 *
 * German strings run roughly 30% longer, which is why layouts are built to flex rather than
 * to fixed widths — `Ausgabeformate` against `Output formats`, or `Verbindung wird
 * wiederhergestellt…` against `Reconnecting…`.
 */
export const i18n = createI18n({
  // Composition API mode; `legacy: true` would break `useI18n()` in `<script setup>`.
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en, de },
});

export type AppLocale = 'en' | 'de';

export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale;
}
