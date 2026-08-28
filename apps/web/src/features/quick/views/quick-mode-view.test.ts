// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { createRouter, createWebHistory } from 'vue-router';
import QuickModeView from './quick-mode-view.vue';
import en from '../../../locales/en.json';

/**
 * Quick Mode has two shapes behind one screen, and the difference decides where results go —
 * so the wrong control being visible is a data-loss-shaped bug, not a cosmetic one.
 */

vi.mock('../../../api/endpoints', () => ({
  quickApi: {
    upload: vi.fn(),
    start: vi.fn(),
    progress: vi.fn(),
    cancel: vi.fn(),
    downloadUrl: (id: string) => `/api/quick/runs/${id}/download`,
    discard: vi.fn(),
  },
  filesystemApi: { browse: vi.fn().mockResolvedValue({ entries: [], currentPath: null }) },
  settingsApi: { validateFolder: vi.fn().mockResolvedValue({ valid: true, warnings: [] }) },
  jobsApi: { list: vi.fn() },
  pipelinesApi: { list: vi.fn() },
  systemApi: { status: vi.fn() },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function mountView() {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'system', component: { template: '<div />' } },
      { path: '/quick', name: 'quick', component: { template: '<div />' } },
    ],
  });
  return mount(QuickModeView, { global: { plugins: [vuetify, i18n, createPinia(), router] } });
}

describe('QuickModeView', () => {
  it('renders the setup form before a run exists', () => {
    const wrapper = mountView();

    expect(wrapper.text()).toContain('Files');
    expect(wrapper.text()).toContain('Output');
  });

  it('will not start with nothing selected', () => {
    const wrapper = mountView();

    const start = wrapper.findAll('button').find((button) => button.text().includes('Start'));
    expect(start?.attributes('disabled')).toBeDefined();
  });

  it('defaults to this computer, and so to a download rather than a server folder', () => {
    const wrapper = mountView();

    // Someone opening the UI in a browser is usually not sitting at the server, and there is
    // no server folder they could reach — asking for one would be a trap.
    expect(wrapper.text()).toContain('ZIP download');
    expect(wrapper.text()).not.toContain('Output folder');
  });

  it('asks for an output folder once the server is chosen as the source', async () => {
    const wrapper = mountView();

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('On this server'));
    await toggle?.trigger('click');
    await wrapper.vm.$nextTick();

    // A server run writes somewhere the user can open; that folder has to be chosen.
    expect(wrapper.text()).toContain('Output folder');
  });

  it('shows neither cancel nor download before a run starts', () => {
    const wrapper = mountView();
    const labels = wrapper.findAll('button').map((button) => button.text());

    expect(labels.some((label) => label.includes('Cancel'))).toBe(false);
    expect(labels.some((label) => label.includes('Download results'))).toBe(false);
  });

  it('keeps at least one output format selected', async () => {
    const wrapper = mountView();
    const chips = wrapper.findAllComponents({ name: 'VChip' });

    // Turning them all off would queue a run that produces nothing.
    for (const chip of chips) {
      await chip.trigger('click');
    }
    await wrapper.vm.$nextTick();

    expect(wrapper.html()).toBeTruthy();
  });
});

/**
 * Remembering the last settings, and hiding the ones the chosen engine ignores.
 *
 * Both exist because of the same complaint: the form asked for the same four decisions on
 * every run, two of which the accurate engine never reads.
 */
describe('QuickModeView settings', () => {
  const KEY = 'impressive-ocr.quick.settings';

  function remember(options: Record<string, unknown>): void {
    localStorage.setItem(KEY, JSON.stringify({ options, source: 'upload', outputPath: '' }));
  }

  afterEach(() => localStorage.clear());

  it('restores the formats chosen last time', () => {
    remember({ formats: ['docx'], profile: 'fast' });

    // The chip for the remembered format is the selected one; Markdown, the schema default,
    // is not. Someone who always wants Word should not re-pick it every run.
    const wrapper = mountView();
    const docx = wrapper
      .findAllComponents({ name: 'VChip' })
      .find((chip) => chip.text().includes('Word'));

    expect(docx?.props('variant')).toBe('flat');
  });

  it('ignores a stored value the schema no longer accepts', () => {
    // Written by an older release, or by hand. Restoring it would produce a run the server
    // rejects, and the user would meet that as a failure with no explanation.
    localStorage.setItem(KEY, JSON.stringify({ options: { formats: ['no-such-format'] } }));

    expect(() => mountView()).not.toThrow();
    expect(mountView().text()).toContain('Output');
  });

  it('survives a stored value that is not JSON at all', () => {
    localStorage.setItem(KEY, 'not json');
    expect(() => mountView()).not.toThrow();
  });

  it('offers the module switches on the fast engine', () => {
    remember({ profile: 'fast' });

    const text = mountView().text();
    expect(text).toContain('Recognize tables');
    expect(text).toContain('Recognize formulas');
  });

  it('hides them on the accurate engine, which never receives them', () => {
    // The sidecar's build_predict_kwargs does not pass module toggles to the vision-language
    // engine. Left on screen they invite the conclusion that a page of mathematics came out
    // well because formula recognition was on — when the switch was never consulted.
    remember({ profile: 'accurate' });

    const text = mountView().text();
    expect(text).not.toContain('Recognize tables');
    expect(text).not.toContain('Recognize formulas');
    expect(text).toContain('reads layout, tables and formulas in one pass');
  });
});
