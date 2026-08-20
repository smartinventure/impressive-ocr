// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { aliases as mdiAliases } from 'vuetify/iconsets/mdi';
import { vuetify } from './vuetify';

/**
 * Every icon alias Vuetify defines must be mapped to a Material Symbols name.
 *
 * Vuetify merges our aliases over its MDI defaults, so a name we forget does not fail -- it
 * quietly keeps a value like `mdi-chevron-up`, and this icon set renders that string as
 * literal text. `collapse` was missing, so every open expansion panel showed the words
 * "mdi-chevron-up" instead of a chevron.
 */
describe('Vuetify icon aliases', () => {
  const ours = vuetify.icons.aliases ?? {};

  it('covers every alias Vuetify ships', () => {
    const missing = Object.keys(mdiAliases).filter((name) => !(name in ours));

    expect(missing).toEqual([]);
  });

  it('never leaves an MDI name behind, which would render as text', () => {
    const leaked = Object.entries(ours)
      .filter(([, value]) => typeof value === 'string' && value.startsWith('mdi-'))
      .map(([name]) => name);

    expect(leaked).toEqual([]);
  });

  it('maps collapse, the one that reached users', () => {
    expect(ours.collapse).toBe('expand_less');
    expect(ours.expand).toBe('expand_more');
  });
});
