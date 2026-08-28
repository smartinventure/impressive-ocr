<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * The small (i) beside a control, opening what that control actually does.
 *
 * Every setting here has a consequence the label cannot carry — a wrong engine costs a batch
 * reprocessed, a wrong text-layer strategy silently passes a scanned page through untouched.
 * Hint text under the field is the wrong place for a paragraph, so the paragraph lives behind
 * an icon and the hint stays one line.
 *
 * Addressed by topic rather than by three string props, because the alternative is five lines
 * of markup at every one of the thirty-odd controls that needs one. `help.<topic>.detail` is
 * optional: some controls warrant a second paragraph, most do not.
 */

const props = defineProps<{ topic: string }>();

const { t, te } = useI18n();
const open = ref(false);

const title = computed(() => t(`help.${props.topic}.title`));
const body = computed(() => t(`help.${props.topic}.body`));
const detail = computed(() =>
  te(`help.${props.topic}.detail`) ? t(`help.${props.topic}.detail`) : null,
);
</script>

<template>
  <span class="info-hint">
    <v-btn
      icon="info"
      variant="text"
      size="x-small"
      density="comfortable"
      class="info-hint__button"
      :aria-label="t('infoHint.aria', { subject: title })"
      @click.stop="open = true"
    />

    <v-dialog v-model="open" max-width="560">
      <v-card>
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ title }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-0">{{ body }}</p>
          <p v-if="detail" class="text-body-2 text-medium-emphasis mb-0 mt-3">{{ detail }}</p>
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
.info-hint {
  display: inline-flex;
  align-items: center;
}

/* Present but quiet: it should be findable beside every control without competing with the
   control itself for attention. */
.info-hint__button {
  opacity: 0.6;
}

.info-hint__button:hover,
.info-hint__button:focus-visible {
  opacity: 1;
}
</style>
