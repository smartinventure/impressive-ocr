// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { createRouter, createWebHistory } from 'vue-router';
import PipelineEditorView from './pipeline-editor-view.vue';
import en from '../../../locales/en.json';

/**
 * The editor renders ~30 controls across six expansion panels.
 *
 * Three of the six were never exercised before a user opened them, and one threw while
 * rendering. A render-time throw inside `VExpansionPanelText` leaves Vue's transition holding
 * a null vnode, which then surfaces as `TypeError: vnode is null` during the *next*
 * navigation -- so the visible symptom was an unrelated page failing to load.
 */

vi.mock('../../../api/endpoints', () => ({
  settingsApi: { validateFolder: vi.fn().mockResolvedValue({ valid: true, message: null }) },
  pipelinesApi: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function mountEditor() {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', name: 'pipelines', component: { template: '<div />' } }],
  });
  return mount(PipelineEditorView, {
    global: { plugins: [vuetify, i18n, createPinia(), router] },
  });
}

/** Panel bodies are lazy; Vuetify only renders one once its panel opens. */
async function openPanel(wrapper: ReturnType<typeof mountEditor>, index: number): Promise<void> {
  const titles = wrapper.findAllComponents({ name: 'VExpansionPanelTitle' });
  await titles[index]?.trigger('click');
  await wrapper.vm.$nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PipelineEditorView', () => {
  it('renders a new pipeline form rather than a blank page', () => {
    const wrapper = mountEditor();

    expect(wrapper.find('.editor').exists()).toBe(true);
    expect(wrapper.findAllComponents({ name: 'VExpansionPanel' })).toHaveLength(6);
  });

  it('opens every panel without throwing', async () => {
    const wrapper = mountEditor();
    const count = wrapper.findAllComponents({ name: 'VExpansionPanel' }).length;

    for (let index = 0; index < count; index += 1) {
      await expect(openPanel(wrapper, index)).resolves.not.toThrow();
    }
  });

  it('renders the Reliability panel, whose quarantine path starts undefined', async () => {
    const wrapper = mountEditor();
    // Index 4 is Reliability: source, engine, output, post, reliability, schedule.
    await openPanel(wrapper, 4);

    expect(wrapper.text()).toContain('Quarantine');
  });

  it('unmounts cleanly after panels have been toggled', async () => {
    // The reported crash: navigating away left `vnode is null` and aborted the route, so the
    // next page never loaded until a full reload.
    const wrapper = mountEditor();
    await openPanel(wrapper, 4);
    await openPanel(wrapper, 5);
    await openPanel(wrapper, 0);

    expect(() => wrapper.unmount()).not.toThrow();
  });
});
