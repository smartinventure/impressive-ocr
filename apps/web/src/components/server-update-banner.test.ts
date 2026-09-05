// SPDX-License-Identifier: AGPL-3.0-or-later
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import type { ServerUpdateStatus } from '@impressive-ocr/shared';
import en from '../locales/en.json';

/**
 * The headless server's update banner, and the rule that it never offers a button that
 * cannot work.
 *
 * The case worth protecting is the third one: a container started by hand has no host updater
 * watching for the request file, so "Update now" would write a file nothing ever reads. The
 * dialog has to show the manual command instead.
 */

const check = vi.hoisted(() => vi.fn());
const trigger = vi.hoisted(() => vi.fn());
const isDesktop = vi.hoisted(() => ({ value: false }));

vi.mock('../api/endpoints', () => ({
  updateApi: {
    check: () => check(),
    trigger: () => trigger(),
  },
}));

vi.mock('../composables/use-desktop-bridge', () => ({
  useDesktopBridge: () => ({ isDesktop }),
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function status(overrides: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus {
  return {
    currentVersion: '1.0.6',
    outcome: { state: 'available', latestVersion: '1.1.0', releaseNotesUrl: null },
    hostUpdate: 'ready',
    updateCommand: 'docker compose pull && docker compose up -d',
    installerUrl: 'https://example.invalid/install.sh',
    checkedAt: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Imported per test rather than once at the top.
 *
 * `use-server-update` holds its state at module scope on purpose -- one check per page
 * however many components ask -- which means a cached answer would otherwise leak from one
 * test into the next and every case after the first would assert against the first's status.
 */
async function render() {
  vi.resetModules();
  const { default: ServerUpdateBanner } = await import('./server-update-banner.vue');
  const wrapper = mount(ServerUpdateBanner, { global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  isDesktop.value = false;
  check.mockResolvedValue(status());
  trigger.mockResolvedValue({ state: 'scheduled' });
});

describe('ServerUpdateBanner', () => {
  it('announces a newer version with both version numbers', async () => {
    const wrapper = await render();
    expect(wrapper.text()).toContain('1.1.0');
    expect(wrapper.text()).toContain('1.0.6');
  });

  it('renders nothing when the server is up to date', async () => {
    check.mockResolvedValue(status({ outcome: { state: 'current' } }));
    const wrapper = await render();
    expect(wrapper.text()).toBe('');
  });

  it('renders nothing when the release feed could not be read', async () => {
    // "Could not check" is not "there is an update". An air-gapped installation must stay
    // silent rather than nag about a version it has no evidence exists.
    check.mockResolvedValue(status({ outcome: { state: 'unreachable', reason: 'network down' } }));
    const wrapper = await render();
    expect(wrapper.text()).toBe('');
  });

  it('never asks the server when running inside the desktop shell', async () => {
    // The desktop app has electron-updater. Asking here as well would offer a container
    // update to someone running an installer.
    isDesktop.value = true;
    await render();
    expect(check).not.toHaveBeenCalled();
  });
});
