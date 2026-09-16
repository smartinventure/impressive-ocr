<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useEngineReadiness } from '../composables/use-engine-readiness';

/**
 * What still has to be installed, said loudly, on the page people actually land on.
 *
 * The drawer notice says the same thing in a line of small text, which is right for "your
 * engine is a version behind" and far too quiet for "nothing can be processed at all". A
 * fresh installation used to announce that state only as a grey chip near the bottom of the
 * System page.
 *
 * It also names *both* downloads whatever the current gap is. The two are easy to confuse
 * and they are discovered in sequence — finish the first and the app immediately asks for a
 * second — which reads like an install that keeps growing. Listing them together makes the
 * shape of the job visible at the start.
 */

const { t } = useI18n();
const { gap } = useEngineReadiness();

/** `runtime-missing` blocks everything; the other two are degradations. */
const severity = computed(() => (gap.value === 'runtime-missing' ? 'error' : 'warning'));
</script>

<template>
  <v-alert v-if="gap !== null" :type="severity" variant="tonal" density="comfortable" class="mb-4">
    <div class="text-subtitle-2 mb-1">{{ t(`engineReadiness.${gap}.title`) }}</div>
    <p class="mb-3">{{ t(`engineReadiness.${gap}.body`) }}</p>

    <!-- Both parts, always. Someone who has just installed the runtime should already know
         the second download exists rather than meeting it as a surprise. -->
    <dl class="engine-readiness__parts mb-3">
      <dt>{{ t('engineReadiness.parts.runtime') }}</dt>
      <dd>{{ t('engineReadiness.parts.runtimeWhat') }}</dd>
      <dt>{{ t('engineReadiness.parts.fast') }}</dt>
      <dd>{{ t('engineReadiness.parts.fastWhat') }}</dd>
    </dl>

    <v-btn size="small" variant="flat" :color="severity" to="/system">
      {{ t('engineReadiness.open') }}
    </v-btn>
  </v-alert>
</template>

<style scoped>
/*
 * A definition list rather than bullets: each part has a name and a consequence, and the
 * pairing is the information. Grid so the two consequences line up and can be compared.
 */
.engine-readiness__parts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
  font-size: 13px;
}

.engine-readiness__parts dt {
  font-weight: 600;
  white-space: nowrap;
}

.engine-readiness__parts dd {
  margin: 0;
  opacity: 0.85;
}
</style>
