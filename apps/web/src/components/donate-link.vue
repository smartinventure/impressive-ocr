<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { DONATE_URL } from '@impressive-ocr/shared';
import { useLicense } from '../composables/use-license';

/**
 * An invitation to support the project, for people using it under the AGPL.
 *
 * A plain link, not PayPal's button SDK, and the reasons are worth keeping. Loading
 * `donate-sdk.js` would mean a script from `paypalobjects.com`, an image from the same, and
 * the SDK's own calls out — three CSP directives to widen on an application whose CSP says
 * `defaultSrc 'self'` because it is local-first, and a direct breach of the rule against
 * CDNs. It would also tell PayPal the IP address of everyone who merely opens the app, which
 * is precisely the kind of quiet reporting this project promises not to do.
 *
 * The hosted button resolves to an ordinary URL, so the donation flow is identical. It also
 * cannot render twice: an SDK that writes into a container renders again whenever that
 * container is re-created, which is why the snippet sometimes produced two buttons.
 *
 * Hidden for commercial licences. Someone who has paid should not be asked for money.
 */

const { t } = useI18n();
const licence = useLicense();

const visible = computed(() => licence.status.value?.tier !== 'commercial');
</script>

<template>
  <a
    v-if="visible"
    class="donate"
    :href="DONATE_URL"
    target="_blank"
    rel="noopener noreferrer"
    :title="t('donate.hint')"
  >
    <v-icon icon="favorite" size="small" />
    <span>{{ t('donate.label') }}</span>
  </a>
</template>

<style scoped>
/* Quiet on purpose: an ask that shouts competes with the navigation it sits under. */
.donate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  text-decoration: none;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.72;
}

.donate:hover {
  opacity: 1;
  text-decoration: underline;
}
</style>
