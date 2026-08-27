<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLicense } from '../../../composables/use-license';
import LicenseStep from '../../../components/license-step.vue';

/**
 * The licence, after first run.
 *
 * Needed because the first-run step can be skipped and should be: someone who declined then
 * has no other way to register, and someone replacing a machine needs to hand its seat back.
 * Both live here rather than only in a dialog nobody can reopen.
 */

const { t, locale } = useI18n();
const licence = useLicense();

onMounted(licence.load);

const isActive = computed(() => licence.status.value?.state === 'active');

const tierLabel = computed(() =>
  licence.status.value?.tier === 'commercial'
    ? t('licence.tierCommercial')
    : t('licence.tierPersonal'),
);

/** Dates come from the licence server as ISO strings; shown in the user's own format. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(locale.value);
}
</script>

<template>
  <v-card class="pa-5 mb-4">
    <h2 class="text-h6 mb-4">{{ t('licence.title') }}</h2>

    <template v-if="isActive && licence.status.value !== null">
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <v-chip size="small" color="succeeded" variant="tonal">{{ tierLabel }}</v-chip>
        <span v-if="licence.status.value.maskedKey" class="text-body-2 ocr-mono">
          {{ licence.status.value.maskedKey }}
        </span>
      </div>

      <p class="text-body-2 mb-1">
        {{ t('licence.activeFor', { email: licence.status.value.email ?? '' }) }}
      </p>

      <p v-if="licence.status.value.seatsAllowed !== null" class="text-body-2 mb-1">
        {{
          t('licence.seats', {
            used: licence.status.value.seatsUsed ?? 0,
            total: licence.status.value.seatsAllowed,
          })
        }}
      </p>

      <!-- Two different sentences on purpose. Passing this date stops automatic updates and
           nothing else, so the expired wording has to say the software keeps working — or it
           reads as "your licence has run out", which is not what was sold. -->
      <p
        v-if="licence.status.value.updatesUntil !== null"
        class="text-body-2 text-medium-emphasis mb-0"
      >
        {{
          licence.status.value.updateAccessExpired
            ? t('licence.updatesEnded', { date: formatDate(licence.status.value.updatesUntil) })
            : t('licence.updatesUntil', { date: formatDate(licence.status.value.updatesUntil) })
        }}
      </p>

      <v-divider class="my-4" />

      <p class="text-body-2 text-medium-emphasis mb-2">{{ t('licence.releaseHint') }}</p>
      <v-btn
        variant="outlined"
        size="small"
        color="failed"
        :loading="licence.busy.value"
        @click="licence.release"
      >
        {{ t('licence.release') }}
      </v-btn>

      <v-alert v-if="licence.error.value" type="error" density="compact" class="mt-3">
        {{ licence.error.value }}
      </v-alert>
    </template>

    <template v-else>
      <p class="text-body-2 text-medium-emphasis mb-4">{{ t('licence.unregistered') }}</p>
      <LicenseStep />
    </template>
  </v-card>
</template>
