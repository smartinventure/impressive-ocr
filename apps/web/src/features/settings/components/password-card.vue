<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { MIN_PASSWORD_LENGTH } from '@impressive-ocr/shared';
import { ApiRequestError } from '../../../api/client';
import { authApi } from '../../../api/endpoints';
import { useAuthStore } from '../../../stores/auth-store';

const emit = defineEmits<{ changed: [] }>();
/**
 * Setting, changing and removing the web UI password.
 *
 * Its own component rather than another block in the settings view: that file is already at
 * the size where a second responsibility starts hiding the first.
 *
 * Nothing here is the security boundary. The server independently requires the current
 * password, enforces the length, and refuses to bind to a network address without both a
 * password and https -- this only tries to explain those rules before the user hits them.
 */

const auth = useAuthStore();
const { t } = useI18n();

const currentPassword = ref('');
const password = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const done = ref<string | null>(null);
const revealed = ref(false);

const tooShort = computed(
  () => password.value !== '' && password.value.length < MIN_PASSWORD_LENGTH,
);

const mismatch = computed(
  () => confirmPassword.value !== '' && confirmPassword.value !== password.value,
);

const canSubmit = computed(
  () =>
    password.value.length >= MIN_PASSWORD_LENGTH &&
    confirmPassword.value === password.value &&
    (!auth.passwordSet || currentPassword.value !== '') &&
    !submitting.value,
);

function reset(): void {
  currentPassword.value = '';
  password.value = '';
  confirmPassword.value = '';
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;

  submitting.value = true;
  error.value = null;
  done.value = null;
  try {
    await authApi.setPassword({
      password: password.value,
      confirmPassword: confirmPassword.value,
      // Only sent when one already exists; the first-run case has nothing to prove.
      ...(auth.passwordSet ? { currentPassword: currentPassword.value } : {}),
    });
    reset();
    done.value = t('auth.passwordSaved');
    // Changing the password invalidates every session, this one included, so the store has
    // to re-check rather than assume it is still signed in.
    await auth.check();
    emit('changed');
  } catch (caught) {
    error.value = messageFor(caught);
  } finally {
    submitting.value = false;
  }
}

async function remove(): Promise<void> {
  submitting.value = true;
  error.value = null;
  done.value = null;
  try {
    await authApi.clearPassword();
    reset();
    done.value = t('auth.passwordRemoved');
    await auth.check();
    emit('changed');
  } catch (caught) {
    error.value = messageFor(caught);
  } finally {
    submitting.value = false;
  }
}

function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiRequestError)) return t('errors.saveFailed');
  if (caught.code === 'invalid-credentials') return t('auth.currentIncorrect');
  if (caught.code === 'password-required') return t('auth.currentRequired');
  return caught.message;
}
</script>

<template>
  <v-card class="pa-5 mb-4">
    <div class="d-flex align-center justify-space-between flex-wrap ga-3 mb-1">
      <h2 class="text-subtitle-1 font-weight-medium">{{ t('auth.passwordTitle') }}</h2>
      <v-chip v-if="auth.passwordSet" size="small" color="success" variant="tonal" label>
        {{ t('auth.passwordSetChip') }}
      </v-chip>
      <v-chip v-else size="small" variant="tonal" label>{{ t('auth.noPasswordChip') }}</v-chip>
    </div>

    <p class="text-body-2 text-medium-emphasis mb-4">{{ t('auth.passwordHint') }}</p>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">
      {{ error }}
    </v-alert>
    <v-alert v-if="done" type="success" variant="tonal" density="compact" class="mb-4">
      {{ done }}
    </v-alert>

    <v-form @submit.prevent="submit">
      <v-text-field
        v-if="auth.passwordSet"
        v-model="currentPassword"
        :label="t('auth.currentPassword')"
        type="password"
        autocomplete="current-password"
        variant="outlined"
        density="comfortable"
        :disabled="submitting"
      />

      <v-text-field
        v-model="password"
        :label="t('auth.newPassword')"
        :type="revealed ? 'text' : 'password'"
        :append-inner-icon="revealed ? 'visibility_off' : 'visibility'"
        autocomplete="new-password"
        variant="outlined"
        density="comfortable"
        :hint="t('auth.minLength', { count: MIN_PASSWORD_LENGTH })"
        persistent-hint
        :error="tooShort"
        :error-messages="tooShort ? t('auth.minLength', { count: MIN_PASSWORD_LENGTH }) : undefined"
        :disabled="submitting"
        @click:append-inner="revealed = !revealed"
      />

      <v-text-field
        v-model="confirmPassword"
        :label="t('auth.repeatPassword')"
        :type="revealed ? 'text' : 'password'"
        autocomplete="new-password"
        variant="outlined"
        density="comfortable"
        class="mt-4"
        :error="mismatch"
        :error-messages="mismatch ? t('auth.mismatch') : undefined"
        :disabled="submitting"
      />

      <div class="d-flex align-center ga-3 flex-wrap mt-2">
        <v-btn type="submit" color="primary" :disabled="!canSubmit" :loading="submitting">
          {{ auth.passwordSet ? t('auth.changePassword') : t('auth.setPassword') }}
        </v-btn>

        <v-btn
          v-if="auth.passwordSet"
          variant="text"
          color="error"
          :disabled="submitting"
          @click="remove"
        >
          {{ t('auth.removePassword') }}
        </v-btn>
      </div>
    </v-form>

    <v-alert v-if="auth.passwordSet" type="info" variant="tonal" density="compact" class="mt-4">
      {{ t('auth.removeWarning') }}
    </v-alert>
  </v-card>
</template>
