// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import LogsView from './logs-view.vue';
import en from '../../../locales/en.json';

/**
 * Reaching the errors.
 *
 * The page could say "11 error(s)" and offer no way to see them: the only filter was a
 * substring match, so finding an error meant guessing a word that appeared in one. The count
 * was a dead end rather than a control.
 */

const tail = vi.hoisted(() => vi.fn());

vi.mock('../../../api/endpoints', () => ({
  logsApi: {
    tail: (...args: unknown[]) => tail(...args),
    clear: vi.fn(),
  },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

/** One pino record per line, which is what the endpoint returns. */
function record(level: number, msg: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ level, time: Date.now(), msg, ...extra });
}

const LOG = [
  record(30, 'Server listening'),
  record(30, 'sidecar', { sidecarRaw: 'Creating model' }),
  record(40, 'Request was slow', { url: '/api/jobs' }),
  record(50, 'Job failed', { jobId: 'job-alpha' }),
  record(50, 'Request failed', { jobId: 'job-beta' }),
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  tail.mockResolvedValue({ text: LOG, truncated: false, totalBytes: LOG.length, files: 1 });
});

async function openLogs() {
  const wrapper = mount(LogsView, { global: { plugins: [vuetify, i18n] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await wrapper.vm.$nextTick();
  return wrapper;
}

function visibleMessages(wrapper: Awaited<ReturnType<typeof openLogs>>): string[] {
  return wrapper.findAll('.logs__message').map((node) => node.text());
}

describe('LogsView filtering', () => {
  it('shows everything by default', async () => {
    // A log that hides things unless asked is worse than a noisy one.
    const wrapper = await openLogs();

    expect(visibleMessages(wrapper)).toHaveLength(5);
  });

  it('narrows to errors', async () => {
    const wrapper = await openLogs();

    await wrapper.findComponent({ name: 'VBtnToggle' }).setValue('error');

    const messages = visibleMessages(wrapper);
    expect(messages).toEqual(['Job failed', 'Request failed']);
  });

  it('includes warnings alongside errors when asked for warnings', async () => {
    const wrapper = await openLogs();

    await wrapper.findComponent({ name: 'VBtnToggle' }).setValue('warn');

    expect(visibleMessages(wrapper)).toHaveLength(3);
  });

  it('combines the level with the text search rather than replacing it', async () => {
    // Narrowing to errors and then typing a job id means the errors for that job.
    const wrapper = await openLogs();

    await wrapper.findComponent({ name: 'VBtnToggle' }).setValue('error');
    await wrapper.findComponent({ name: 'VTextField' }).setValue('job-alpha');

    expect(visibleMessages(wrapper)).toEqual(['Job failed']);
  });

  it('counts errors regardless of the filter in force', async () => {
    // The chip reports what the log holds, not what is on screen; otherwise filtering to
    // warnings would claim the errors had gone away.
    const wrapper = await openLogs();

    await wrapper.findComponent({ name: 'VBtnToggle' }).setValue('warn');

    expect(wrapper.text()).toContain('2 error(s)');
  });
});
