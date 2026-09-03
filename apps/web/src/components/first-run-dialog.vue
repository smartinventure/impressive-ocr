<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import {
  COMMERCIAL_LICENCE_URL,
  LICENCE_ENQUIRY_URL,
  PRIVACY_URL,
  TERMS_URL,
} from '@impressive-ocr/shared';
import { useFirstRun } from '../composables/use-first-run';
import LicenseStep from './license-step.vue';

/**
 * What a fresh installation has to pass through: the terms, then a pointer at the engine.
 *
 * Asked here rather than in the installer because the installer is not a place every user
 * goes. The AppImage is run, not installed; the container has no installer; and someone using
 * the headless server from a browser never sees one. This is the only prompt all of them
 * reach — and the only one whose answer can be recorded and re-asked when the terms change.
 *
 * `persistent` with no close affordance on the first step: consent that can be dismissed is
 * not consent. The second step is advice, so it can be waved away.
 */

const { t } = useI18n();
const router = useRouter();
const { step, isOpen, accepting, error, load, accept, acknowledgeEngine, settleLicence } =
  useFirstRun();

onMounted(load);

function goToSystem(): void {
  acknowledgeEngine();
  void router.push({ name: 'system' });
}
</script>

<template>
  <v-dialog :model-value="isOpen" persistent max-width="640" scrollable>
    <!-- Step one: the agreement. -->
    <v-card v-if="step === 'consent'" rounded="lg">
      <v-card-title class="text-h6 pt-5 px-6">{{ t('firstRun.consent.title') }}</v-card-title>

      <v-card-text class="px-6">
        <p class="mb-4">{{ t('firstRun.consent.intro') }}</p>

        <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
          <div class="text-subtitle-2 mb-1">{{ t('firstRun.licence.title') }}</div>
          <p class="mb-2">{{ t('firstRun.licence.free') }}</p>
          <p class="mb-0">
            {{ t('firstRun.licence.commercial') }}
            <a :href="LICENCE_ENQUIRY_URL" target="_blank" rel="noopener noreferrer">
              {{ t('firstRun.licence.enquire') }}
            </a>
          </p>
        </v-alert>

        <p class="mb-2">{{ t('firstRun.consent.documents') }}</p>
        <ul class="first-run__links mb-4">
          <li>
            <a :href="TERMS_URL" target="_blank" rel="noopener noreferrer">
              {{ t('firstRun.consent.terms') }}
            </a>
          </li>
          <li>
            <a :href="PRIVACY_URL" target="_blank" rel="noopener noreferrer">
              {{ t('firstRun.consent.privacy') }}
            </a>
          </li>
          <!-- The terms an organisation actually buys. Listed for everyone rather than shown
               only after someone picks the commercial tier: it is the document that decides
               whether they need to, so hiding it behind that choice is backwards. -->
          <li>
            <a :href="COMMERCIAL_LICENCE_URL" target="_blank" rel="noopener noreferrer">
              {{ t('firstRun.consent.commercialLicence') }}
            </a>
          </li>
        </ul>

        <p class="text-medium-emphasis text-body-2 mb-0">{{ t('firstRun.consent.noTelemetry') }}</p>

        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">
          {{ error }}
        </v-alert>
      </v-card-text>

      <v-card-actions class="px-6 pb-5">
        <v-spacer />
        <v-btn color="primary" variant="flat" :loading="accepting" @click="accept">
          {{ t('firstRun.consent.agree') }}
        </v-btn>
      </v-card-actions>
    </v-card>

    <!-- Step two: which licence this installation runs under. Skippable, always. -->
    <v-card v-else-if="step === 'licence'" rounded="lg">
      <v-card-title class="text-h6 pt-5 px-6">{{ t('licence.title') }}</v-card-title>
      <v-card-text class="px-6 pb-5">
        <LicenseStep show-skip @done="settleLicence" @skip="settleLicence" />
      </v-card-text>
    </v-card>

    <!-- Step three: nothing can be OCR'd until the engine is downloaded. -->
    <v-card v-else-if="step === 'engine'" rounded="lg">
      <v-card-title class="text-h6 pt-5 px-6">{{ t('firstRun.engine.title') }}</v-card-title>

      <v-card-text class="px-6">
        <p class="mb-3">{{ t('firstRun.engine.body') }}</p>
        <p class="mb-0 text-medium-emphasis text-body-2">{{ t('firstRun.engine.size') }}</p>
      </v-card-text>

      <v-card-actions class="px-6 pb-5">
        <v-btn variant="text" @click="acknowledgeEngine">{{ t('firstRun.engine.later') }}</v-btn>
        <v-spacer />
        <v-btn color="primary" variant="flat" prepend-icon="monitor_heart" @click="goToSystem">
          {{ t('firstRun.engine.open') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.first-run__links {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.first-run__links a {
  color: rgb(var(--v-theme-primary));
}
</style>
