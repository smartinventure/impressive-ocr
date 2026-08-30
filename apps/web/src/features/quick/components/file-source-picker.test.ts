// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import FileSourcePicker from './file-source-picker.vue';
import en from '../../../locales/en.json';

/**
 * Which controls each source offers.
 *
 * This exists because of a regression that shipped: the upload branch was a bare `v-else`, so
 * inserting the folder button above it re-pointed that `v-else` at the *new* condition. In a
 * browser, where a folder cannot be picked, the upload branch then rendered beside the server
 * one and the page showed two buttons both saying "Add files". Nothing tested the picker, so
 * nothing noticed.
 */

vi.mock('../../../api/endpoints', () => ({
  filesystemApi: { browse: vi.fn().mockResolvedValue({ entries: [], currentPath: null }) },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function picker(source: 'server' | 'upload') {
  return mount(FileSourcePicker, {
    props: {
      source,
      serverFiles: [],
      uploadFiles: [],
      serverFolder: '',
      folderExtensions: ['pdf'],
    },
    global: { plugins: [vuetify, i18n] },
  });
}

/** Buttons whose own label is "Add files", ignoring the dialog title that shares the string. */
function addFilesButtons(wrapper: ReturnType<typeof picker>) {
  return wrapper
    .findAllComponents({ name: 'VBtn' })
    .filter((button) => button.text().trim().toLowerCase() === 'add files');
}

describe('FileSourcePicker', () => {
  it('offers one way to add files on the server, not two', () => {
    expect(addFilesButtons(picker('server'))).toHaveLength(1);
  });

  it('offers one way to add files from this computer, not two', () => {
    expect(addFilesButtons(picker('upload'))).toHaveLength(1);
  });

  it('does not show the upload input while the server is selected', () => {
    // The tell for the regression: the file input belongs to the other branch entirely.
    expect(picker('server').find('input[type="file"]').exists()).toBe(false);
  });

  it('shows the upload input when this computer is selected', () => {
    expect(picker('upload').find('input[type="file"]').exists()).toBe(true);
  });

  it('does not offer a folder in a browser, where one cannot be chosen', () => {
    // `selectFolder` needs the desktop bridge; without it the button would open nothing.
    expect(picker('server').text()).not.toContain('Add a folder');
  });
});
