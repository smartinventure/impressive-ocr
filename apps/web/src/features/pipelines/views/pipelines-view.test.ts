// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { createRouter, createWebHistory } from 'vue-router';
import PipelinesView from './pipelines-view.vue';
import { useLiveStore } from '../../../stores/live-store';
import en from '../../../locales/en.json';

/**
 * Editing and deleting from the list, and the rule that they wait for a pause.
 *
 * `jobs.pipeline_id` cascades on delete, so removing a pipeline mid-document takes the running
 * job's record with it while the sidecar carries on working. The gate is what makes that
 * unlikely; the server cancelling in-flight jobs first is what makes it safe anyway.
 */

const remove = vi.hoisted(() => vi.fn());

vi.mock('../../../api/endpoints', () => ({
  pipelinesApi: {
    remove: (...args: unknown[]) => remove(...args),
    pause: vi.fn(),
    resume: vi.fn(),
  },
  systemApi: { pauseAll: vi.fn(), resumeAll: vi.fn() },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/pipelines', name: 'pipelines', component: { template: '<div />' } },
    { path: '/pipelines/new', name: 'pipeline-new', component: { template: '<div />' } },
    { path: '/pipelines/:id', name: 'pipeline-detail', component: { template: '<div />' } },
    { path: '/pipelines/:id/edit', name: 'pipeline-edit', component: { template: '<div />' } },
  ],
});

function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Invoices',
    description: '',
    enabled: false,
    kind: 'watched',
    status: 'idle',
    statusReason: null,
    stats: { processed: 0, total: 0, queued: 0 },
    options: {
      source: { inputPath: 'C:/in' },
      output: { outputPath: 'C:/out' },
      engine: { profile: 'fast', device: 'auto' },
    },
    ...overrides,
  };
}

async function showing(pipelines: unknown[], jobs: unknown[] = []) {
  setActivePinia(createPinia());
  const store = useLiveStore();
  store.pipelines = pipelines as never;
  store.jobs = jobs as never;
  store.refresh = vi.fn();

  const wrapper = mount(PipelinesView, { global: { plugins: [vuetify, i18n, router] } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

function buttonWithIcon(wrapper: Awaited<ReturnType<typeof showing>>, icon: string) {
  return wrapper.findAllComponents({ name: 'VBtn' }).find((button) => button.html().includes(icon));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PipelinesView row actions', () => {
  it('offers edit and delete on a paused pipeline', async () => {
    const wrapper = await showing([pipeline({ enabled: false })]);

    expect(buttonWithIcon(wrapper, 'edit')?.props('disabled')).toBe(false);
    expect(buttonWithIcon(wrapper, 'delete')?.props('disabled')).toBe(false);
  });

  it('disables both while the pipeline is running', async () => {
    const wrapper = await showing([pipeline({ enabled: true })]);

    expect(buttonWithIcon(wrapper, 'edit')?.props('disabled')).toBe(true);
    expect(buttonWithIcon(wrapper, 'delete')?.props('disabled')).toBe(true);
  });

  it('says why rather than only greying out', async () => {
    // A disabled control with no reason teaches nothing and reads as a bug. The hint sits on
    // a wrapping span, because a disabled button emits no pointer events and a tooltip bound
    // to the button itself would never open.
    const wrapper = await showing([pipeline({ enabled: true })]);

    const hints = wrapper.findAll('span[title]').map((node) => node.attributes('title'));
    expect(hints.some((hint) => hint?.includes('Pause this pipeline before'))).toBe(true);
  });

  it('describes the action itself once the pipeline is paused', async () => {
    const wrapper = await showing([pipeline({ enabled: false })]);

    const hints = wrapper.findAll('span[title]').map((node) => node.attributes('title'));
    expect(hints).toContain('Edit');
    expect(hints).toContain('Delete');
  });

  it('asks before deleting, naming the pipeline', async () => {
    // Fifteen cards on screen: "this pipeline" is not enough to act on.
    const wrapper = await showing([pipeline({ name: 'Invoices' })]);

    await buttonWithIcon(wrapper, 'delete')?.trigger('click');
    await wrapper.vm.$nextTick();

    expect(document.body.textContent).toContain('Invoices');
    expect(remove).not.toHaveBeenCalled();
  });
});

/**
 * Which document is being read, on the list rather than only on the detail page.
 *
 * The counters beside it come from `pipeline.status`, which the server used to publish only
 * when a job *finished* — so a card showed nothing at all until the work was over. This half
 * needs no new event: `store.jobs` is kept live by `job.upserted` and already carries the
 * name and the state.
 */
describe('PipelinesView running file', () => {
  const runningJob = {
    id: 'j1',
    pipelineId: 'p1',
    fileName: 'invoice-2026.pdf',
    state: 'running',
    pagesDone: 2,
    pageCount: 8,
  };

  it('names the file currently being read', async () => {
    const wrapper = await showing([pipeline({ enabled: true })], [runningJob]);

    expect(wrapper.text()).toContain('invoice-2026.pdf');
  });

  it('says nothing when the pipeline is idle', async () => {
    // An empty "Reading" line on every idle card would be noise on the busiest screen.
    const wrapper = await showing([pipeline({ enabled: true })], []);

    expect(wrapper.text()).not.toContain('Reading');
  });

  it('ignores a job belonging to another pipeline', async () => {
    const wrapper = await showing(
      [pipeline({ id: 'p1' })],
      [{ ...runningJob, pipelineId: 'other' }],
    );

    expect(wrapper.text()).not.toContain('invoice-2026.pdf');
  });

  it('ignores a job that is queued rather than running', async () => {
    const wrapper = await showing([pipeline()], [{ ...runningJob, state: 'pending' }]);

    expect(wrapper.text()).not.toContain('invoice-2026.pdf');
  });
});
