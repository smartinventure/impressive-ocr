// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { createRouter, createWebHistory } from 'vue-router';
import type { LicenseGateState, LicenseStatus } from '@impressive-ocr/shared';
import LicenseBanner from './license-banner.vue';
import en from '../locales/en.json';

/**
 * The banner has to be silent for a licensed installation and say the *right* thing for each
 * way of not being one — telling an offline paying customer to "register" would be nonsense.
 */

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function status(
  gateState: LicenseGateState,
  overrides: Partial<LicenseStatus> = {},
): LicenseStatus {
  return {
    state: 'unregistered',
    tier: null,
    email: null,
    maskedKey: null,
    activatedAt: null,
    licenseExpires: null,
    updatesUntil: null,
    updateAccessExpired: false,
    seatsUsed: null,
    seatsAllowed: null,
    message: null,
    code: null,
    gate: {
      state: gateState,
      canProcess: gateState !== 'blocked',
      daysRemaining: gateState === 'licensed' ? null : 7,
      gracePeriodEndsAt: null,
    },
    ...overrides,
  };
}

function render(value: LicenseStatus | null) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', name: 'system', component: { template: '<div />' } }],
  });
  return mount(LicenseBanner, {
    props: { status: value },
    global: { plugins: [vuetify, i18n, router] },
  });
}

describe('LicenseBanner', () => {
  it('says nothing to a licensed installation', () => {
    // Which is most installations, most of the time. A permanent banner about a licence that
    // is in order is noise.
    expect(render(status('licensed')).text()).toBe('');
  });

  it('says nothing before the status has loaded', () => {
    expect(render(null).text()).toBe('');
  });

  it('counts down the trial', () => {
    expect(render(status('trial')).text()).toContain('7');
  });

  it('asks an unregistered installation to register once blocked', () => {
    const text = render(status('blocked')).text();

    expect(text).toContain('Registration is required');
    // And says what is not lost, because "blocked" reads as "my documents are gone".
    expect(text).toContain('already produced stays available');
  });

  it('tells a blocked paying customer to get online, not to register', () => {
    // The two blocked cases have nothing in common but the word. Someone who has paid and is
    // simply offline must not be told to do the thing they already did.
    const text = render(status('blocked', { state: 'active', tier: 'commercial' })).text();

    expect(text).toContain('Connect to the internet');
    expect(text).not.toContain('Registration is required');
  });

  it('warns about a stale confirmation without alarming', () => {
    const wrapper = render(status('offline-grace', { state: 'active' }));

    expect(wrapper.text()).toContain('could not be confirmed');
    // Warning, not error: nothing has stopped working yet.
    expect(wrapper.findComponent({ name: 'VAlert' }).props('type')).toBe('warning');
  });

  it('turns red only when work has actually stopped', () => {
    expect(render(status('trial')).findComponent({ name: 'VAlert' }).props('type')).toBe('warning');
    expect(render(status('blocked')).findComponent({ name: 'VAlert' }).props('type')).toBe('error');
  });
});
