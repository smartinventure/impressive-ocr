// SPDX-License-Identifier: AGPL-3.0-or-later
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createI18n } from 'vue-i18n';
import EngineHelp from './engine-help.vue';
import en from '../../../locales/en.json';
import de from '../../../locales/de.json';

/**
 * The engines fail differently rather than merely at different speeds, and choosing wrong
 * costs a reprocessed batch. This explanation is the only place that is said.
 */

const vuetify = createVuetify({ components, directives });

function render(locale: 'en' | 'de' = 'en') {
  const i18n = createI18n({ legacy: false, locale, messages: { en, de } });
  return mount(EngineHelp, { global: { plugins: [vuetify, i18n] } });
}

describe('EngineHelp', () => {
  it('offers the question rather than assuming the answer is obvious', () => {
    expect(render().text()).toContain('Which engine should I choose?');
  });

  it('keeps the explanation closed until it is asked for', () => {
    // The form is long enough already; this is a paragraph most people read once.
    expect(document.body.textContent).not.toContain('Choosing an OCR engine');
  });

  it('explains both engines and the measured cost once opened', async () => {
    const wrapper = render();
    await wrapper.find('button').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The dialog teleports to the body, so the assertions read from there.
    const text = document.body.textContent ?? '';
    expect(text).toContain('Choosing an OCR engine');
    // The measured figures, which are the reason this exists rather than a vague "slower".
    expect(text).toContain('~5 s');
    expect(text).toContain('~80 s');
    // And the finding that a speed comparison alone would hide.
    expect(text).toContain('wrong order');

    wrapper.unmount();
  });

  it('is translated, not English text behind a German label', async () => {
    const wrapper = render('de');

    expect(wrapper.text()).toContain('Welche Engine soll ich wählen?');

    wrapper.unmount();
  });
});
