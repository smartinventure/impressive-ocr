// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import FolderPickerField from './folder-picker-field.vue';
import en from '../locales/en.json';

/**
 * The picker is handed optional paths.
 *
 * `reliability.quarantinePath` is `absolutePathSchema.optional()`, so it is `undefined` until
 * the user fills it in -- and the field's debounced validator called `.trim()` on whatever it
 * was given.
 */

vi.mock('../api/endpoints', () => ({
  settingsApi: { validateFolder: vi.fn().mockResolvedValue({ valid: true, message: null }) },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function mountField(modelValue: unknown) {
  return mount(FolderPickerField, {
    props: { modelValue: modelValue as string, label: 'Quarantine folder' },
    global: { plugins: [vuetify, i18n, createPinia()] },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FolderPickerField', () => {
  it('mounts with a value', () => {
    expect(() => mountField('C:/scans/in')).not.toThrow();
  });

  it('survives an undefined value, which optional paths always start as', async () => {
    const wrapper = mountField(undefined);

    // The validator is debounced by 400ms; the crash happened in the timer, not on mount,
    // which is why it read as an unrelated error later on.
    await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
    expect(wrapper.exists()).toBe(true);
  });

  it('survives a null value', async () => {
    const wrapper = mountField(null);
    await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
    expect(wrapper.exists()).toBe(true);
  });

  it('does not ask the server to validate an empty path', async () => {
    const { settingsApi } = await import('../api/endpoints');
    mountField(undefined);
    await vi.advanceTimersByTimeAsync(600);

    expect(settingsApi.validateFolder).not.toHaveBeenCalled();
  });
});
