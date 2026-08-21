// SPDX-License-Identifier: AGPL-3.0-or-later
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import type { PreflightReport } from '@impressive-ocr/shared';
import PreflightCard from './preflight-card.vue';
import en from '../../../locales/en.json';

/**
 * The card exists to keep two very different verdicts from looking alike.
 *
 * `fixable` is one download away; `blocked` is a machine that will never run the engine. A
 * user who reads the second as the first keeps trying, which is exactly the afternoon this
 * screen is meant to prevent.
 */

const preflight = vi.fn();

vi.mock('../../../api/endpoints', () => ({
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

async function mountCard(value: PreflightReport | Error) {
  preflight.mockReset();
  if (value instanceof Error) {
    preflight.mockRejectedValue(value);
  } else {
    preflight.mockResolvedValue(value);
  }
  const wrapper = mount(PreflightCard, { global: { plugins: [vuetify, i18n] } });
  await flushPromises();
  return wrapper;
}

describe('PreflightCard', () => {
  it('announces that the machine cannot run the engine, above the detail', async () => {
    const wrapper = await mountCard(
      report({
        canInstall: false,
        checks: [
          {
            id: 'cpu-avx',
            severity: 'blocked',
            title: 'CPU instruction set',
            detail: 'Intel(R) Pentium(R) CPU 4415Y does not support AVX.',
            remedy: null,
          },
        ],
      }),
    );

    expect(wrapper.text()).toContain('This machine cannot run the OCR engine.');
    expect(wrapper.text()).toContain('does not support AVX');
  });

  it('shows a remedy with its download link for a fixable check', async () => {
    const wrapper = await mountCard(
      report({
        hasFixable: true,
        checks: [
          {
            id: 'vc-runtime',
            severity: 'fixable',
            title: 'Microsoft Visual C++ runtime',
            detail: 'Missing from System32: vcomp140.dll.',
            remedy: {
              summary: 'Install the Microsoft Visual C++ 2015-2022 Redistributable (x64)',
              downloadUrl: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
              steps: ['Download it.', 'Run it.'],
            },
          },
        ],
      }),
    );

    expect(wrapper.text()).toContain('Redistributable');
    expect(wrapper.find('a').attributes('href')).toBe(
      'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    );
    // Fixable is not a refusal, so the blocking banner must not appear.
    expect(wrapper.text()).not.toContain('cannot run the OCR engine');
  });

  it('does not claim the machine is blocked when every check passes', async () => {
    const wrapper = await mountCard(
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

    expect(wrapper.text()).not.toContain('cannot run the OCR engine');
    expect(wrapper.text()).toContain('80.0 GB available.');
  });

  it('says the probe failed rather than rendering an empty list as all clear', async () => {
    const wrapper = await mountCard(new Error('network'));

    expect(wrapper.text()).toContain('could not run');
    expect(wrapper.text()).not.toContain('cannot run the OCR engine');
  });

  it('renders every remedy step, since the order is the instruction', async () => {
    const wrapper = await mountCard(
      report({
        hasFixable: true,
        checks: [
          {
            id: 'disk-space',
            severity: 'fixable',
            title: 'Free disk space',
            detail: 'Not enough room.',
            remedy: { summary: 'Free up space', downloadUrl: null, steps: ['One.', 'Two.'] },
          },
        ],
      }),
    );

    expect(wrapper.findAll('.preflight__steps li')).toHaveLength(2);
    expect(wrapper.find('a').exists()).toBe(false);
  });
});
