// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ThemeDefinition } from 'vuetify';

/**
 * The design system, transcribed from `_resources/design/from-claude-design/v2`.
 *
 * The dark values are the design team's own pairs, not a derivation. That distinction
 * matters in two places they called out explicitly:
 *
 *  - The brand green `#14532D` is unreadable on a dark surface, so it lifts to `#4E9B6C`.
 *    A programmatic "darken the light theme" would have kept it and produced illegible
 *    primary buttons at night.
 *  - Alert surfaces **dim rather than invert**: a dark amber wash (`#1E1810`), not a
 *    lightened tint. A straight inversion glares in a dark room.
 */

/** Tokens with no Vuetify slot of their own; consumed through CSS variables. */
export interface ExtraTokens {
  surfaceMuted: string;
  field: string;
  onSurfaceMuted: string;
  primaryHover: string;
  alertWarnSurface: string;
  alertWarnBorder: string;
  alertWarnText: string;
  alertErrorSurface: string;
  alertErrorBorder: string;
  alertErrorText: string;
}

export const lightTheme: ThemeDefinition = {
  dark: false,
  colors: {
    background: '#F7F8F4',
    surface: '#FBFCFA',
    'surface-bright': '#FFFFFF',
    'surface-variant': '#EDEFEA',
    'on-surface': '#111111',
    'on-surface-variant': '#5A6159',
    'outline-variant': '#E4E8DF',
    outline: '#D3D8CE',
    primary: '#14532D',
    'on-primary': '#FFFFFF',
    'primary-container': '#E8F0EA',
    'on-primary-container': '#14532D',

    // Status palette. Never used alone — every surface pairs colour with an icon and a
    // label, so the six stay distinguishable for colour-blind users.
    queued: '#4C5663',
    running: '#1D4ED8',
    paused: '#B45309',
    succeeded: '#0F766E',
    failed: '#B91C1C',
    quarantined: '#6D28D9',

    // Vuetify's semantic slots, aligned with the status palette so an alert and a chip
    // reporting the same thing cannot drift apart.
    info: '#1D4ED8',
    success: '#0F766E',
    warning: '#B45309',
    error: '#B91C1C',
  },
};

export const darkTheme: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#101512',
    surface: '#171D19',
    'surface-bright': '#1C231F',
    'surface-variant': '#222A25',
    'on-surface': '#E8EDE9',
    'on-surface-variant': '#A7B1A9',
    'outline-variant': '#2B342E',
    outline: '#2B342E',
    primary: '#4E9B6C',
    'on-primary': '#08160E',
    'primary-container': '#16301F',
    'on-primary-container': '#9BE0B4',

    queued: '#9FADBD',
    running: '#84A9F5',
    paused: '#E3A85E',
    // Held apart from the brand green in both hue and lightness, so "finished" is never
    // mistaken for "this is the app's accent".
    succeeded: '#4FC7B0',
    failed: '#F19191',
    quarantined: '#B99BF7',

    info: '#84A9F5',
    success: '#4FC7B0',
    warning: '#E3A85E',
    error: '#F19191',
  },
};

export const lightExtras: ExtraTokens = {
  surfaceMuted: '#F7F8F4',
  field: '#FBFCFA',
  onSurfaceMuted: '#8A9186',
  primaryHover: '#1B6B3A',
  alertWarnSurface: '#FDF6EC',
  alertWarnBorder: '#F0DDBF',
  alertWarnText: '#8A4A06',
  alertErrorSurface: '#FEF6F6',
  alertErrorBorder: '#F3D3D3',
  alertErrorText: '#B91C1C',
};

export const darkExtras: ExtraTokens = {
  surfaceMuted: '#171D19',
  field: '#131916',
  onSurfaceMuted: '#7E8A81',
  primaryHover: '#63B181',
  // Dimmed, not inverted — the design team's explicit call.
  alertWarnSurface: '#1E1810',
  alertWarnBorder: '#2C2214',
  alertWarnText: '#E0C89E',
  alertErrorSurface: '#1B1212',
  alertErrorBorder: '#301A1A',
  alertErrorText: '#F19191',
};

/** Background tints behind a status chip, per theme. */
export const statusSurfaces = {
  light: {
    queued: { bg: '#F1F3F5', border: '#DDE1E6' },
    running: { bg: '#EEF2FB', border: '#CBD8F2' },
    paused: { bg: '#FDF6EC', border: '#F0DDBF' },
    succeeded: { bg: '#ECF7F5', border: '#C3E4DE' },
    failed: { bg: '#FEF6F6', border: '#F3D3D3' },
    quarantined: { bg: '#F5F1FE', border: '#DED2F8' },
  },
  dark: {
    queued: { bg: '#1B2128', border: '#2B3138' },
    running: { bg: '#16203A', border: '#26304A' },
    paused: { bg: '#2C2214', border: '#3C3224' },
    succeeded: { bg: '#0F2A28', border: '#1F3A38' },
    failed: { bg: '#301A1A', border: '#402A2A' },
    quarantined: { bg: '#231B3A', border: '#332B4A' },
  },
} as const;

export type StatusKey = keyof (typeof statusSurfaces)['light'];

/** Emit the non-Vuetify tokens as CSS variables so plain CSS can reach them. */
export function extrasToCssVariables(extras: ExtraTokens): Record<string, string> {
  return {
    '--ocr-surface-muted': extras.surfaceMuted,
    '--ocr-field': extras.field,
    '--ocr-on-surface-muted': extras.onSurfaceMuted,
    '--ocr-primary-hover': extras.primaryHover,
    '--ocr-alert-warn-surface': extras.alertWarnSurface,
    '--ocr-alert-warn-border': extras.alertWarnBorder,
    '--ocr-alert-warn-text': extras.alertWarnText,
    '--ocr-alert-error-surface': extras.alertErrorSurface,
    '--ocr-alert-error-border': extras.alertErrorBorder,
    '--ocr-alert-error-text': extras.alertErrorText,
  };
}
