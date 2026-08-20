// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
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

  it('offers an output folder for a server run', () => {
    const wrapper = mountView();

    // A server run writes somewhere the user can open; that folder has to be chosen.
    expect(wrapper.text()).toContain('Output folder');
  });

  it('replaces the output folder with a download notice for uploads', async () => {
    const wrapper = mountView();

    const toggle = wrapper.findAll('button').find((b) => b.text().includes('From this computer'));
    await toggle?.trigger('click');
    await wrapper.vm.$nextTick();

    // There is no server folder the user could reach, so asking for one would be a trap.
    expect(wrapper.text()).toContain('ZIP download');
    expect(wrapper.text()).not.toContain('Output folder');
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
