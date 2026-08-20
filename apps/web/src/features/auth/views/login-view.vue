<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { ApiRequestError } from '../../../api/client';
import { useAuthStore } from '../../../stores/auth-store';

/**
 * The sign-in screen.
 *
 * Shown only when a password is set and authentication is on. Every failure reads the same,
 * whatever the cause: distinguishing "no password configured" from "wrong password" would
 * tell an unauthenticated visitor which instances are worth their time.
 */

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { t } = useI18n();

const password = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const field = ref<HTMLInputElement | null>(null);

async function submit(): Promise<void> {
  if (submitting.value || password.value === '') return;

  submitting.value = true;
  error.value = null;
  try {
    await auth.signIn(password.value);
    password.value = '';
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.replace(target);
  } catch (cause) {
    error.value =
      cause instanceof ApiRequestError && cause.code === 'network-error'
        ? t('auth.unreachable')
        : t('auth.incorrect');
    password.value = '';
    // Put the cursor back where the user needs it rather than making them click again.
    await nextTick();
    field.value?.focus();
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  field.value?.focus();
});
</script>

<template>
  <div class="login">
    <v-card class="login__card pa-6" max-width="420" width="100%">
      <div class="login__brand mb-5">
        <span class="login__brand-light">Impressive</span><span class="login__brand-bold">OCR</span>
      </div>

      <h1 class="text-h6 mb-1">{{ t('auth.signInTitle') }}</h1>
      <p class="text-body-2 text-medium-emphasis mb-5">{{ t('auth.signInHint') }}</p>

      <v-form @submit.prevent="submit">
        <v-text-field
          ref="field"
          v-model="password"
          :label="t('auth.password')"
          type="password"
          autocomplete="current-password"
          variant="outlined"
          density="comfortable"
          :error-messages="error === null ? undefined : error"
          :disabled="submitting"
        />

        <v-btn
          type="submit"
          color="primary"
          block
          size="large"
          :loading="submitting"
          :disabled="password === ''"
        >
          {{ t('auth.signIn') }}
        </v-btn>
      </v-form>
    </v-card>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
}

.login__brand {
  font-size: 1.25rem;
  letter-spacing: -0.02em;
}

.login__brand-light {
  font-weight: 300;
}

.login__brand-bold {
  font-weight: 700;
}
</style>
