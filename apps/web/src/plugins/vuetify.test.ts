// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

  it('no component passes an MDI name straight to v-icon', () => {
    // The aliases below are only what Vuetify asks for internally. An icon written by hand
    // in a template bypasses them entirely, and this set renders the string it is given --
    // so `icon="mdi-bug-outline"` put the words "mdi-bug-outline" in the navigation drawer,
    // struck through and overlapping the button it belonged to.
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          const source = readFileSync(full, 'utf8');
          // The plugin itself names MDI in its comments and imports; everything else must not.
          if (full.includes('vuetify.ts')) continue;
          if (/icon\s*[:=]\s*["'`]mdi-/.test(source)) offenders.push(entry.name);
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
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
