<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  COMMERCIAL_LICENCE_URL,
  PERSONAL_SEAT_LIMIT,
  REGISTRATION_GRACE_DAYS,
} from '@impressive-ocr/shared';
import { useLicense } from '../composables/use-license';

/**
 * Which licence this installation runs under, asked once.
 *
 * Used by the first-run dialog and by the System page, which is why the walk lives in
 * `use-license.ts` and this file is a template.
 *
 * Two things it deliberately does not do. It never blocks: `skip` is always offered, because
 * an unregistered copy is running under the AGPL and is entitled to. And it never claims
 * registering is finished — the licence server sends a verification link and then a *second*
 * email with the key, so the screen between them says exactly that rather than congratulating
 * someone whose licence has not arrived yet.
 */

const props = defineProps<{ showSkip?: boolean }>();
const emit = defineEmits<{ done: []; skip: [] }>();

const { t, locale } = useI18n();
const licence = useLicense();

onMounted(licence.load);

const countries = computed(() => licence.countryOptions(locale.value));

/** Which tier the key form is being used for: the stored one, else what was chosen. */
const isCommercial = computed(
  () => (licence.status.value?.tier ?? licence.chosenTier.value) === 'commercial',
);

async function activate(): Promise<void> {
  await licence.activate();
  if (licence.status.value?.state === 'active') emit('done');
}
</script>

<template>
  <div class="licence">
    <v-alert v-if="licence.error.value" type="error" density="compact" class="mb-4">
      <div>{{ licence.error.value }}</div>
      <!-- The code, quoted verbatim. The sentence above tells the user what to do; this is
           what they paste into a support email when it does not. -->
      <div v-if="licence.errorCode.value" class="text-caption ocr-mono mt-1">
        {{ licence.errorCode.value }}
      </div>
    </v-alert>

    <!-- Which licence, and it is a real question rather than an upsell: the free tier is
         the AGPL grant, not a trial. -->
    <template v-if="licence.screen.value === 'choose'">
      <p class="mb-4">{{ t('licence.chooseIntro') }}</p>

      <v-card variant="outlined" class="pa-4 mb-3" @click="licence.choose('personal')">
        <div class="text-subtitle-1 font-weight-medium mb-1">{{ t('licence.personalTitle') }}</div>
        <p class="text-body-2 text-medium-emphasis mb-0">
          {{ t('licence.personalBody', { seats: PERSONAL_SEAT_LIMIT }) }}
        </p>
      </v-card>

      <v-card variant="outlined" class="pa-4" @click="licence.choose('commercial')">
        <div class="text-subtitle-1 font-weight-medium mb-1">
          {{ t('licence.commercialTitle') }}
        </div>
        <p class="text-body-2 text-medium-emphasis mb-2">{{ t('licence.commercialBody') }}</p>
        <p class="text-body-2 text-medium-emphasis mb-2">
          {{ t('licence.commercialTrial', { days: REGISTRATION_GRACE_DAYS }) }}
        </p>
        <a
          :href="COMMERCIAL_LICENCE_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="text-body-2"
          @click.stop
        >
          {{ t('licence.commercialLink') }}
        </a>
      </v-card>
    </template>

    <!-- Free registration. Country is required by the licence server, so it is required here
         rather than sent empty and refused after the user has finished typing. -->
    <template v-else-if="licence.screen.value === 'register'">
      <p class="mb-4">{{ t('licence.registerIntro', { seats: PERSONAL_SEAT_LIMIT }) }}</p>

      <v-text-field
        v-model="licence.email.value"
        type="email"
        autocomplete="email"
        :label="t('licence.email')"
        :hint="t('licence.emailHint')"
        persistent-hint
        :disabled="licence.busy.value"
        class="mb-4"
      />

      <v-autocomplete
        v-model="licence.country.value"
        :items="countries"
        :label="t('licence.country')"
        :disabled="licence.busy.value"
        class="mb-2"
      />

      <div class="d-flex ga-3 flex-wrap">
        <v-btn
          color="primary"
          :disabled="!licence.canRegister.value"
          :loading="licence.busy.value"
          @click="licence.register"
        >
          {{ t('licence.register') }}
        </v-btn>
        <v-btn variant="text" :disabled="licence.busy.value" @click="licence.reconsider">
          {{ t('common.back') }}
        </v-btn>
      </div>
    </template>

    <!-- The step that would otherwise look like a bug: registered, but no key yet. -->
    <template v-else-if="licence.screen.value === 'awaiting-key'">
      <v-alert type="success" variant="tonal" density="comfortable" class="mb-4">
        {{ t('licence.sentTo', { email: licence.status.value?.email ?? '' }) }}
      </v-alert>

      <ol class="licence__steps mb-4">
        <li>{{ t('licence.stepVerify') }}</li>
        <li>{{ t('licence.stepKey') }}</li>
        <li>{{ t('licence.stepEnter') }}</li>
      </ol>

      <div class="d-flex ga-3 flex-wrap">
        <v-btn color="primary" @click="licence.enterKey">{{ t('licence.haveKey') }}</v-btn>
        <v-btn v-if="props.showSkip" variant="text" @click="emit('skip')">
          {{ t('licence.later') }}
        </v-btn>
      </div>
    </template>

    <!-- Entering a key: the same form for a community key that arrived by email and a
         commercial one that came with a purchase. -->
    <template v-else-if="licence.screen.value === 'activate'">
      <p class="mb-2">{{ t('licence.activateIntro') }}</p>
      <!-- Commercial keys are not self-served: the licence server no longer lets anyone
           register for one, so the only way to have a key is to have bought it. Saying so
           here saves someone hunting for a sign-up form that does not exist. -->
      <p v-if="isCommercial" class="text-body-2 text-medium-emphasis mb-4">
        {{ t('licence.commercialPurchase') }}
        <a :href="COMMERCIAL_LICENCE_URL" target="_blank" rel="noopener noreferrer">
          {{ t('licence.commercialBuy') }}
        </a>
      </p>
      <div v-else class="mb-4" />

      <v-text-field
        v-model="licence.email.value"
        type="email"
        autocomplete="email"
        :label="t('licence.email')"
        :disabled="licence.busy.value"
        class="mb-4"
      />

      <v-text-field
        v-model="licence.licenseKey.value"
        :label="t('licence.key')"
        :hint="t('licence.keyHint')"
        persistent-hint
        :disabled="licence.busy.value"
        class="mb-2 ocr-mono"
      />

      <div class="d-flex ga-3 flex-wrap">
        <v-btn
          color="primary"
          :disabled="!licence.canActivate.value"
          :loading="licence.busy.value"
          @click="activate"
        >
          {{ t('licence.activate') }}
        </v-btn>
        <v-btn variant="text" :disabled="licence.busy.value" @click="licence.reconsider">
          {{ t('common.back') }}
        </v-btn>
      </div>
    </template>

    <template v-else>
      <v-alert type="success" variant="tonal" density="comfortable" class="mb-2">
        {{ t('licence.activeFor', { email: licence.status.value?.email ?? '' }) }}
      </v-alert>
      <p
        v-if="licence.status.value?.seatsAllowed !== null"
        class="text-body-2 text-medium-emphasis mb-0"
      >
        {{
          t('licence.seats', {
            used: licence.status.value?.seatsUsed ?? 0,
            total: licence.status.value?.seatsAllowed ?? 0,
          })
        }}
      </p>
    </template>

    <!-- Always available, on every screen: an unregistered installation is running under the
         AGPL and is entitled to. A licence step that could not be passed would be a lock. -->
    <div v-if="props.showSkip && licence.screen.value !== 'awaiting-key'" class="mt-4">
      <v-btn variant="text" size="small" @click="emit('skip')">{{ t('licence.later') }}</v-btn>
    </div>
  </div>
</template>

<style scoped>
.licence__steps {
  padding-left: 1.25rem;
  font-size: 0.875rem;
  line-height: 1.7;
}
</style>
