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
import { useLiveStore } from '../../../stores/live-store';
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

/**
 * @param authorizedFolders Folders on the allowlist. Empty means the editor should refuse to
 *   render a form the server could only reject.
 */
function mountEditor(authorizedFolders: string[] = ['C:/scans']) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', name: 'pipelines', component: { template: '<div />' } },
      { path: '/settings', name: 'settings', component: { template: '<div />' } },
    ],
  });
  const pinia = createPinia();
  const wrapper = mount(PipelineEditorView, {
    global: { plugins: [vuetify, i18n, pinia, router] },
  });

  // Seed the store as a finished load would; `loading` starts true, which would otherwise
  // mask the gate and let these tests pass for the wrong reason.
  const store = useLiveStore(pinia);
  store.loading = false;
  store.settings = { folderAllowlist: authorizedFolders } as never;

  return wrapper;
}

/**
 * The slice of a chip wrapper these assertions use.
 *
 * `findAllComponents` on a `DOMWrapper` is untyped, so without this the callbacks below are
 * implicit `any` and `noImplicitAny` rejects the file. Naming the surface is honest; an `as`
 * cast would only hide it.
 */
type ChipWrapper = {
  text: () => string;
  props: (name: string) => unknown;
  trigger: (event: string) => Promise<void>;
};

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
    expect(wrapper.findAllComponents({ name: 'VExpansionPanel' })).toHaveLength(7);
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

  it('offers every output format, not only the selected ones', () => {
    // The regression: the chips bound `:model-value` to "is this format selected", but on
    // VChip that prop controls the chip's own visibility (`isActive.value && createVNode`).
    // Every unselected format therefore rendered nothing, so a brand-new pipeline showed only
    // the default chip -- and since a chip that is not rendered cannot be clicked, Word, Excel,
    // HTML, plain text and searchable PDF were unreachable on a pipeline entirely.
    const wrapper = mountEditor();
    const chips = wrapper.find('.editor__formats').findAllComponents({ name: 'VChip' });

    expect(chips).toHaveLength(8);
    const labels = chips.map((chip: ChipWrapper) => chip.text());
    for (const label of [
      'Markdown',
      'JSON',
      'Plain text',
      'Word',
      'Excel',
      'HTML',
      'Searchable PDF',
      'Overlay image',
    ]) {
      expect(labels.some((text: string) => text.includes(label))).toBe(true);
    }
  });

  it('offers the text encoding only once plain text is an output', async () => {
    // It drives the .txt writer and nothing else, so offering it while no .txt is being
    // written would be a control that silently does nothing.
    const wrapper = mountEditor();

    expect(wrapper.text()).not.toContain('Plain-text encoding');

    const chips = wrapper.find('.editor__formats').findAllComponents({ name: 'VChip' });
    const txt = chips.find((chip: ChipWrapper) => chip.text().includes('Plain text'));
    await txt?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Plain-text encoding');
  });

  it('keeps the last output format selected', async () => {
    // `formats` is `.min(1)`, so emptying it would fail validation only on save -- after the
    // whole form had been filled in. The sole remaining chip is disabled instead.
    const wrapper = mountEditor();
    const chips = wrapper.find('.editor__formats').findAllComponents({ name: 'VChip' });
    const markdown = chips.find((chip: ChipWrapper) => chip.text().includes('Markdown'));

    expect(markdown?.props('disabled')).toBe(true);

    await markdown?.trigger('click');

    expect(wrapper.find('.editor__formats').text()).toContain('Markdown');
  });

  it('starts with every expert override unset', async () => {
    // Unset is not cosmetic: an unset field is omitted from the OCR call, so a pipeline that
    // never opens this panel must behave exactly as it did before the panel existed.
    const wrapper = mountEditor();
    // Index 6 is Expert: source, engine, output, post, reliability, schedule, expert.
    await openPanel(wrapper, 6);

    const panel = wrapper.findComponent({ name: 'ExpertSettingsPanel' });
    expect(panel.exists()).toBe(true);
    expect(panel.props('modelValue')).toEqual({});
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

/**
 * The engine panel offers a rendering resolution and seven module switches, and the accurate
 * engine reads none of them: the sidecar's `build_predict_kwargs` sends the vision-language
 * pipeline nothing but a page limit. Showing a setting that is quietly ignored is worse than
 * not offering it, because it invites tuning a run with a control that was never connected.
 */
describe('PipelineEditorView engine settings', () => {
  async function openEngine(): Promise<ReturnType<typeof mountEditor>> {
    const wrapper = mountEditor();
    // Index 1 is Engine: source, engine, output, post, reliability, schedule.
    await openPanel(wrapper, 1);
    return wrapper;
  }

  async function setProfile(
    wrapper: ReturnType<typeof mountEditor>,
    profile: 'fast' | 'accurate',
  ): Promise<void> {
    const selects = wrapper.findAllComponents({ name: 'VSelect' });
    const engine = selects.find((select) => String(select.props('label')).includes('Engine'));
    engine?.vm.$emit('update:modelValue', profile);
    await wrapper.vm.$nextTick();
  }

  it('offers resolution and modules on the fast engine', async () => {
    const wrapper = await openEngine();
    await setProfile(wrapper, 'fast');

    expect(wrapper.text()).toContain('Scan resolution');
    expect(wrapper.text()).toContain('Recognize tables');
  });

  it('hides them on the accurate engine', async () => {
    const wrapper = await openEngine();
    await setProfile(wrapper, 'accurate');

    expect(wrapper.text()).not.toContain('Scan resolution');
    expect(wrapper.text()).not.toContain('Recognize tables');
    expect(wrapper.text()).toContain('reads layout, tables and formulas in one pass');
  });

  it('keeps the settings it hid, so switching back restores them', async () => {
    // Hidden, not reset: a pipeline moved to the accurate engine and back should not have
    // silently lost the resolution and modules its owner chose.
    const wrapper = await openEngine();
    await setProfile(wrapper, 'accurate');
    await setProfile(wrapper, 'fast');

    expect(wrapper.text()).toContain('Scan resolution');
    expect(wrapper.text()).toContain('Recognize tables');
  });
});
