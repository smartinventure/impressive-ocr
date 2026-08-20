// SPDX-License-Identifier: AGPL-3.0-or-later
import { h } from 'vue';
import { createVuetify, type IconSet, type IconProps } from 'vuetify';
import { darkTheme, lightTheme } from './theme';

/**
 * Vuetify setup.
 *
 * Fonts and icons are bundled, never fetched. The design canvas links Google Fonts, but this
 * app is local-first with a `'self'` CSP — a font request to a CDN would both break under the
 * policy and quietly tell Google when someone opens their OCR tool.
 */

/**
 * Material Symbols Rounded, the icon family the design uses.
 *
 * Vuetify ships MDI by default, whose names and shapes differ. Rather than translate every
 * icon name in the design, register Material Symbols as the icon set: names then match the
 * canvas exactly, which is one fewer thing to get subtly wrong.
 */
const materialSymbols: IconSet = {
  component: (props: IconProps) =>
    h(
      'span',
      { class: ['material-symbols-rounded', 'ocr-icon'], 'aria-hidden': 'true' },
      typeof props.icon === 'string' ? props.icon : '',
    ),
};

export const vuetify = createVuetify({
  theme: {
    defaultTheme: 'light',
    themes: { light: lightTheme, dark: darkTheme },
    variations: {
      colors: ['primary'],
      lighten: 2,
      darken: 2,
    },
  },
  icons: {
    defaultSet: 'materialSymbols',
    sets: { materialSymbols },
    aliases: {
      // Vuetify's internal components ask for these by alias, so they must be mapped or
      // checkboxes and selects render empty boxes.
      complete: 'check',
      cancel: 'cancel',
      close: 'close',
      delete: 'cancel',
      clear: 'cancel',
      success: 'check_circle',
      info: 'info',
      warning: 'warning',
      error: 'error',
      prev: 'chevron_left',
      next: 'chevron_right',
      checkboxOn: 'check_box',
      checkboxOff: 'check_box_outline_blank',
      checkboxIndeterminate: 'indeterminate_check_box',
      delimiter: 'circle',
      sortAsc: 'arrow_upward',
      sortDesc: 'arrow_downward',
      expand: 'expand_more',
      menu: 'menu',
      subgroup: 'arrow_drop_down',
      dropdown: 'arrow_drop_down',
      radioOn: 'radio_button_checked',
      radioOff: 'radio_button_unchecked',
      edit: 'edit',
      ratingEmpty: 'star_outline',
      ratingFull: 'star',
      ratingHalf: 'star_half',
      loading: 'progress_activity',
      first: 'first_page',
      last: 'last_page',
      unfold: 'unfold_more',
      file: 'draft',
      plus: 'add',
      minus: 'remove',
      calendar: 'calendar_month',
      treeviewCollapse: 'chevron_right',
      treeviewExpand: 'expand_more',
      eyeDropper: 'colorize',
      upload: 'upload',
      color: 'palette',
      command: 'keyboard_command_key',
      ctrl: 'keyboard_control_key',
      space: 'space_bar',
      shift: 'shift',
      alt: 'keyboard_option_key',
      enter: 'keyboard_return',
      arrowup: 'arrow_upward',
      arrowdown: 'arrow_downward',
      arrowleft: 'arrow_back',
      arrowright: 'arrow_forward',
      backspace: 'backspace',
    },
  },
  defaults: {
    // Flat surfaces with hairline borders, matching the canvas — Vuetify's default
    // elevation shadows would fight the design's very restrained depth.
    VCard: { flat: true, border: true, rounded: 'lg' },
    VBtn: { variant: 'flat', rounded: 'md' },
    VTextField: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VSelect: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VTextarea: { variant: 'outlined', density: 'comfortable', hideDetails: 'auto' },
    VChip: { rounded: 'pill' },
    VList: { density: 'comfortable' },
    VAlert: { variant: 'tonal', border: 'start', rounded: 'md' },
  },
});
