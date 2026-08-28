<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * "Which engine should I choose?", answered where the choice is made.
 *
 * The two engines are not fast-versus-slow versions of the same thing: they fail differently.
 * The fast one reads characters well and can still put them in the wrong order on a
 * multi-column page, which produces output that looks plausible and is unusable. Nothing in a
 * dropdown label conveys that, and the cost of picking wrong is a whole batch reprocessed.
 *
 * A dialog rather than more hint text: it is a paragraph of explanation that most people need
 * once, and the form is already long.
 */

const { t } = useI18n();
const open = ref(false);
</script>

<template>
  <div>
    <v-btn variant="text" size="small" prepend-icon="help" @click="open = true">
      {{ t('engineHelp.trigger') }}
    </v-btn>

    <v-dialog v-model="open" max-width="720">
      <v-card>
        <v-card-title class="text-h6">{{ t('engineHelp.title') }}</v-card-title>

        <v-card-text>
          <div class="engine-help__grid">
            <section>
              <h3 class="text-subtitle-2 font-weight-medium mb-1">
                {{ t('engineHelp.fastTitle') }}
              </h3>
              <p class="text-body-2 mb-2">{{ t('engineHelp.fastFor') }}</p>
              <p class="text-body-2 text-medium-emphasis mb-0">{{ t('engineHelp.fastLimit') }}</p>
            </section>

            <section>
              <h3 class="text-subtitle-2 font-weight-medium mb-1">
                {{ t('engineHelp.accurateTitle') }}
              </h3>
              <p class="text-body-2 mb-2">{{ t('engineHelp.accurateFor') }}</p>
              <p class="text-body-2 text-medium-emphasis mb-0">
                {{ t('engineHelp.accurateLimit') }}
              </p>
            </section>
          </div>

          <v-divider class="my-4" />

          <h3 class="text-subtitle-2 font-weight-medium mb-2">
            {{ t('engineHelp.measuredTitle') }}
          </h3>
          <p class="text-body-2 mb-2">{{ t('engineHelp.measuredIntro') }}</p>

          <v-table density="compact" class="mb-3">
            <thead>
              <tr>
                <th>{{ t('engineHelp.colSetting') }}</th>
                <th>{{ t('engineHelp.colSpeed') }}</th>
                <th>{{ t('engineHelp.colQuality') }}</th>
              </tr>
            </thead>
            <tbody>
              <!-- Quality is a property of the engine, not of the device, so it repeats
                   down each pair. Shown per row anyway: the whole point of the table is that
                   the accurate engine is no longer the slow one, and a merged cell would
                   invite reading the speed column as the only thing that differs. -->
              <tr>
                <td>{{ t('engineHelp.rowFastGpu') }}</td>
                <td class="ocr-mono">{{ t('engineHelp.fastGpuSpeed') }}</td>
                <td class="ocr-mono">95%</td>
              </tr>
              <tr>
                <td>{{ t('engineHelp.rowAccurateGpu') }}</td>
                <td class="ocr-mono">{{ t('engineHelp.accurateGpuSpeed') }}</td>
                <td class="ocr-mono">98%</td>
              </tr>
              <tr>
                <td>{{ t('engineHelp.rowFastCpu') }}</td>
                <td class="ocr-mono">{{ t('engineHelp.fastCpuSpeed') }}</td>
                <td class="ocr-mono">95%</td>
              </tr>
              <tr>
                <td>{{ t('engineHelp.rowAccurateCpu') }}</td>
                <td class="ocr-mono">{{ t('engineHelp.accurateCpuSpeed') }}</td>
                <td class="ocr-mono">98%</td>
              </tr>
            </tbody>
          </v-table>

          <p class="text-body-2 text-medium-emphasis mb-2">{{ t('engineHelp.qualityNote') }}</p>
          <p class="text-body-2 text-medium-emphasis mb-0">{{ t('engineHelp.hardwareNote') }}</p>
        </v-card-text>

        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="open = false">{{ t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.engine-help__grid {
  display: grid;
  /* Side by side where there is room; stacked on a narrow window, where the German text is
     long enough that two columns would be unreadable. */
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1.5rem;
}
</style>
