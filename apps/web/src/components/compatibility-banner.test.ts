// SPDX-License-Identifier: AGPL-3.0-or-later
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import type { PreflightCheck, PreflightReport } from '@impressive-ocr/shared';
import CompatibilityBanner from './compatibility-banner.vue';
import en from '../locales/en.json';

/**
 * The dashboard's answer to "can this machine run OCR at all".
 *
 * Its most important behaviour is staying quiet: a banner that appears on every healthy load
 * is one users stop reading, and then it is not there when it matters.
 */

const preflight = vi.fn();

vi.mock('../api/endpoints', () => ({
  systemApi: { preflight: () => preflight() },
}));

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    canInstall: true,
    hasFixable: false,
    checks: [],
    checkedAt: '2026-08-21T12:00:00.000Z',
    ...overrides,
  };
}

async function mountBanner(value: PreflightReport | Error) {
  preflight.mockReset();
  if (value instanceof Error) {
    preflight.mockRejectedValue(value);
  } else {
    preflight.mockResolvedValue(value);
  }
  const wrapper = mount(CompatibilityBanner, {
    global: {
      plugins: [vuetify, i18n],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  });
  await flushPromises();
  return wrapper;
}

const BLOCKED_AVX: PreflightCheck = {
  id: 'cpu-avx',
  severity: 'blocked',
  title: 'CPU instruction set',
  detail: 'Intel(R) Pentium(R) CPU 4415Y does not support AVX.',
  remedy: null,
};

const FIXABLE_VC: PreflightCheck = {
  id: 'vc-runtime',
  severity: 'fixable',
  title: 'Microsoft Visual C++ runtime',
  detail: 'Missing from System32: vcomp140.dll.',
  remedy: {
    summary: 'Install the Microsoft Visual C++ 2015-2022 Redistributable (x64)',
    downloadUrl: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    steps: ['Download it.'],
  },
};

describe('CompatibilityBanner', () => {
  it('says nothing at all when every check passes', async () => {
    const wrapper = await mountBanner(
      report({
        checks: [
          {
            id: 'disk-space',
            severity: 'ok',
            title: 'Free disk space',
            detail: '80.0 GB available.',
            remedy: null,
          },
        ],
      }),
    );

    expect(wrapper.text()).toBe('');
  });

  it('reports a machine that cannot run the engine, with the reason', async () => {
    const wrapper = await mountBanner(report({ canInstall: false, checks: [BLOCKED_AVX] }));

    expect(wrapper.text()).toContain('cannot run the OCR engine');
    expect(wrapper.text()).toContain('does not support AVX');
  });

  it('summarises what to install when the problem is fixable', async () => {
    const wrapper = await mountBanner(report({ hasFixable: true, checks: [FIXABLE_VC] }));

    expect(wrapper.text()).toContain('needs to be installed');
    expect(wrapper.text()).toContain('Redistributable');
    // A fixable problem is not a dead machine, and must not be announced as one.
    expect(wrapper.text()).not.toContain('cannot run the OCR engine');
  });

  it('leads with the blocking problem when both kinds are present', async () => {
    const wrapper = await mountBanner(
      report({ canInstall: false, hasFixable: true, checks: [BLOCKED_AVX, FIXABLE_VC] }),
    );

    expect(wrapper.text()).toContain('cannot run the OCR engine');
    expect(wrapper.text()).not.toContain('needs to be installed');
  });

  it('points at the System page, where the install lives', async () => {
    const wrapper = await mountBanner(report({ hasFixable: true, checks: [FIXABLE_VC] }));

    expect(wrapper.text()).toContain('Open System');
  });

  it('stays silent when the check itself fails, rather than alarming on a disconnect', async () => {
    const wrapper = await mountBanner(new Error('network'));

    expect(wrapper.text()).toBe('');
  });
});
