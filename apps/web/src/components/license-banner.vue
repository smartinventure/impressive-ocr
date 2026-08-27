<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LicenseStatus } from '@impressive-ocr/shared';

/**
 * A line above the content when the licence needs attention.
 *
 * Presentational: the shell already holds the licence status for the header label, and giving
 * this its own `useLicense` meant two identical requests on every start.
 *
 * Shown only when there is something to act on, so an installation that is registered and
 * recently confirmed sees nothing at all — which is most installations, most of the time.
 * Never covers the screen and never needs dismissing: even when work is blocked, every page
 * stays reachable, and a modal that could not be closed would trap someone away from the
 * System page they would go to in order to fix it.
 */

const props = defineProps<{ status: LicenseStatus | null }>();

const { t } = useI18n();

const gate = computed(() => props.status?.gate ?? null);

/** Nothing to say to someone whose licence is in order. */
const visible = computed(() => gate.value !== null && gate.value.state !== 'licensed');

const tone = computed(() => (gate.value?.canProcess === false ? 'error' : 'warning'));

const message = computed(() => {
  const current = gate.value;
  if (current === null) return '';

  const days = current.daysRemaining ?? 0;
  if (current.state === 'trial') return t('licence.trial', { days });
  if (current.state === 'offline-grace') return t('licence.offlineGrace', { days });

  // Blocked, and the two reasons need different advice: one is "register", the other is
  // "get online". Telling an offline paying customer to register would be nonsense.
  return props.status?.state === 'active'
    ? t('licence.offlineBlocked')
    : t('licence.trialBlocked');
});
</script>

<template>
  <v-alert v-if="visible" :type="tone" variant="tonal" density="compact" rounded="0">
    <div class="d-flex align-center justify-space-between flex-wrap ga-3">
      <span class="text-body-2">{{ message }}</span>
      <v-btn size="small" variant="text" :to="{ name: 'system' }">
        {{ t('licence.registerNow') }}
      </v-btn>
    </div>
  </v-alert>
</template>
