<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * How the two engines actually work, for the reader who wants to know.
 *
 * Deliberately separate from the Quick Mode dialog, which answers a different question for a
 * different person. That one is "which should I pick for this batch" and belongs beside the
 * control. This one is "why are these two things different at all", and belongs on System,
 * next to the hardware and the install state it explains.
 *
 * Worth writing down because almost every surprising behaviour in this application follows
 * from the architecture: why four recognisers vanish when Accurate is chosen, why DPI only
 * affects one of them, why the profile that is *not* called fast is the faster one, and why a
 * Mac with a capable GPU still reports "no compatible GPU".
 */

const { t } = useI18n();
const open = ref(false);
</script>

<template>
  <span>
    <v-btn variant="text" size="small" prepend-icon="memory" @click="open = true">
      {{ t('engineInternals.trigger') }}
    </v-btn>

    <v-dialog v-model="open" max-width="760" scrollable>
      <v-card>
        <v-card-title class="text-h6">{{ t('engineInternals.title') }}</v-card-title>

        <v-card-text class="text-body-2">
          <p class="mb-4">{{ t('engineInternals.intro') }}</p>

          <h3 class="text-subtitle-2 font-weight-medium mb-1">
            {{ t('engineInternals.pipeline.title') }}
          </h3>
          <p class="mb-2">{{ t('engineInternals.pipeline.body') }}</p>
          <!-- The stages, as a chain. Reading it left to right is the explanation: every
               stage is a separate model, which is why the toggles exist and why turning one
               on costs memory. -->
          <p class="engine-internals__chain ocr-mono mb-2">
            {{ t('engineInternals.pipeline.chain') }}
          </p>
          <p class="text-medium-emphasis mb-4">{{ t('engineInternals.pipeline.consequence') }}</p>

          <h3 class="text-subtitle-2 font-weight-medium mb-1">
            {{ t('engineInternals.model.title') }}
          </h3>
          <p class="mb-2">{{ t('engineInternals.model.body') }}</p>
          <p class="text-medium-emphasis mb-4">{{ t('engineInternals.model.consequence') }}</p>

          <h3 class="text-subtitle-2 font-weight-medium mb-1">
            {{ t('engineInternals.order.title') }}
          </h3>
          <p class="mb-2">{{ t('engineInternals.order.body') }}</p>
          <p class="text-medium-emphasis mb-4">{{ t('engineInternals.order.measured') }}</p>

          <h3 class="text-subtitle-2 font-weight-medium mb-1">
            {{ t('engineInternals.batching.title') }}
          </h3>
          <p class="mb-2">{{ t('engineInternals.batching.body') }}</p>
          <p class="text-medium-emphasis mb-4">{{ t('engineInternals.batching.consequence') }}</p>

          <h3 class="text-subtitle-2 font-weight-medium mb-1">
            {{ t('engineInternals.apple.title') }}
          </h3>
          <p class="mb-2">{{ t('engineInternals.apple.body') }}</p>
          <p class="text-medium-emphasis mb-0">{{ t('engineInternals.apple.consequence') }}</p>
        </v-card-text>

        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="open = false">{{ t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </span>
</template>

<style scoped>
/* Set apart from the prose, because it is a diagram rather than a sentence. */
.engine-internals__chain {
  padding: 8px 10px;
  border-radius: 6px;
  background: rgb(var(--v-theme-on-surface) / 0.05);
  font-size: 12px;
  line-height: 1.6;
}
</style>
