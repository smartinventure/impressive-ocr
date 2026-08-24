// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import { quickOptionsSchema, type QuickOptions } from '@impressive-ocr/shared';
import RunSettingsSummary from './run-settings-summary.vue';
import en from '../../../locales/en.json';

/**
 * Once a run starts the form is replaced by the progress card, so this is the only place the
 * choices that produced a result remain visible. Comparing two engines on one document is
 * meaningless if the screen no longer says which engine ran.
 */

const vuetify = createVuetify({ components, directives });
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });

function render(overrides: Partial<QuickOptions> = {}) {
  const options = { ...quickOptionsSchema.parse({}), ...overrides };
  return mount(RunSettingsSummary, {
    props: { options },
    global: { plugins: [vuetify, i18n] },
  });
}

describe('RunSettingsSummary', () => {
  it('names the engine that was chosen', () => {
    expect(render({ profile: 'accurate' }).text()).toContain('Accurate');
    expect(render({ profile: 'fast' }).text()).toContain('Fast');
  });

  it('reports the requested device, not only whatever ran', () => {
    // The neighbouring chip shows the resolved device. Both are needed: "I asked for
    // automatic and it chose CPU" is only answerable when the request is visible too.
    expect(render({ device: 'auto' }).text()).toContain('Automatic');
    expect(render({ device: 'cpu' }).text()).toContain('CPU');
  });

  it('lists every selected output format', () => {
    const text = render({ formats: ['markdown', 'docx'] }).text();

    expect(text).toContain('Markdown');
    expect(text).toContain('Word');
  });

  it('shows the text-layer strategy', () => {
    expect(render({ textLayerStrategy: 'always-ocr' }).text()).toContain('Always OCR');
  });

  it('mentions the optional modules only when they are on', () => {
    expect(render({ tableRecognition: false, formulaRecognition: false }).text()).not.toContain(
      'Tables',
    );

    const both = render({ tableRecognition: true, formulaRecognition: true }).text();
    expect(both).toContain('Tables');
    expect(both).toContain('Formulas');
  });

  it('uses short labels rather than the picker sentences', () => {
    // The dropdowns read "Fast — good on everyday documents"; that does not belong in a chip
    // on a card that is already showing progress.
    expect(render({ profile: 'fast' }).text()).not.toContain('good on everyday documents');
  });
});
