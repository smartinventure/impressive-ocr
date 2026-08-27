// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import SystemView from './system-view.vue';
import en from '../../../locales/en.json';

/**
 * The runtime install downloads between 1.5 and 3.5 GB depending on a hardware probe the user
 * never sees. It must never start from a single click.
 */

const runtimePlan = vi.fn();
const installRuntime = vi.fn();

vi.mock('../../../api/endpoints', () => ({
  systemApi: {
    hardware: vi.fn().mockResolvedValue({
      platform: 'win32',
      arch: 'x64',
      cpuModel: 'Test CPU',
      cpuCores: 8,
      totalMemoryBytes: 32 * 1024 ** 3,
      gpu: null,
      gpuUnavailableReason: 'no-nvidia-driver',
      canUseGpu: false,
      availableProfiles: ['fast'],
      probedAt: '2026-08-21T00:00:00.000Z',
      explanation: 'No NVIDIA driver found.',
    }),
    runtimePlan: (...args: unknown[]) => runtimePlan(...args),
    installRuntime: (...args: unknown[]) => installRuntime(...args),
    probeHardware: vi.fn(),
    // The System page also renders the preflight card, which calls this on mount. Unmocked
    // it rejects, and the failure surfaces as the install button never being found.
    preflight: vi.fn().mockResolvedValue({
      canRun: true,
      checks: [],
      blockers: [],
    }),
  },
  // The System page also renders the licence card, on the same principle as the preflight
  // card above: unmocked, its mounted hook throws and the page never finishes rendering.
  licenseApi: {
    get: vi.fn().mockResolvedValue({
      state: 'unregistered',
      tier: null,
      email: null,
      maskedKey: null,
      gate: { state: 'trial', canProcess: true, daysRemaining: 30, gracePeriodEndsAt: null },
    }),
    countries: vi.fn().mockResolvedValue(null),
    registerPersonal: vi.fn(),
    activate: vi.fn(),
    release: vi.fn(),
  },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

const PLAN = {
  flavor: 'gpu' as const,
  packageName: 'paddlepaddle-gpu',
  description: 'PaddlePaddle GPU (bundled CUDA 12.9)',
  rationale: 'NVIDIA GeForce RTX 4060 Ti, driver 591.86, runs this bundled CUDA build.',
  downloadBytes: 1_664_000_000,
  installedBytes: 3_900_000_000,
  targetPath: 'D:\\data\\runtime',
  freeBytes: 3_000_000_000_000,
  enoughSpace: true,
};

function mountView() {
  return mount(SystemView, { global: { plugins: [vuetify, i18n, createPinia()] } });
}

beforeEach(() => {
  setActivePinia(createPinia());
  runtimePlan.mockReset().mockResolvedValue(PLAN);
  installRuntime.mockReset().mockResolvedValue(undefined);
});

/**
 * The install button, found by its label.
 *
 * Not `find('button')`: that returns the first button on the page, so it silently became the
 * preflight card's "Check again" the moment a card was added above the runtime section.
 */
function installButton(wrapper: ReturnType<typeof mountView>) {
  const button = wrapper
    .findAll('button')
    .find((candidate) => candidate.text().includes('Install the OCR runtime'));
  if (button === undefined) {
    throw new Error('The install button is not rendered.');
  }
  return button;
}

describe('SystemView runtime install', () => {
  it('asks for the plan and downloads nothing when the install button is pressed', async () => {
    const wrapper = mountView();
    await wrapper.vm.$nextTick();

    await installButton(wrapper).trigger('click');
    await wrapper.vm.$nextTick();

    expect(runtimePlan).toHaveBeenCalledTimes(1);
    expect(installRuntime).not.toHaveBeenCalled();
  });

  it('shows the build, both sizes and the destination before asking', async () => {
    const wrapper = mountView();
    await wrapper.vm.$nextTick();
    await installButton(wrapper).trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const text = document.body.textContent ?? '';
    expect(text).toContain('PaddlePaddle GPU (bundled CUDA 12.9)');
    expect(text).toContain('1.5 GB'); // download
    expect(text).toContain('3.6 GB'); // on disk when done
    expect(text).toContain('D:\\data\\runtime');
    expect(installRuntime).not.toHaveBeenCalled();
  });

  it('starts the install only once the confirmation is accepted', async () => {
    const wrapper = mountView();
    await wrapper.vm.$nextTick();
    await installButton(wrapper).trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    const confirm = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Download and install'),
    );
    expect(confirm).toBeDefined();
    confirm?.click();
    await wrapper.vm.$nextTick();

    expect(installRuntime).toHaveBeenCalledTimes(1);
  });
});
