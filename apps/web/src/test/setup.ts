// SPDX-License-Identifier: AGPL-3.0-or-later
import { vi } from 'vitest';

/**
 * jsdom is missing the layout and observer APIs Vuetify reaches for.
 *
 * These are stubs, not emulation: the tests here assert that components mount, render and
 * unmount without throwing, which is the class of bug that reached users. They deliberately
 * do not assert pixel layout, which jsdom could not answer honestly anyway.
 */

globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

globalThis.IntersectionObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];
} as unknown as typeof IntersectionObserver;

// Vuetify's display composable reads this on mount.
globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof matchMedia;

// VOverlay — every dialog, menu and tooltip — subscribes to this when it opens.
globalThis.visualViewport ??= {
  width: 1024,
  height: 768,
  scale: 1,
  offsetLeft: 0,
  offsetTop: 0,
  pageLeft: 0,
  pageTop: 0,
  onresize: null,
  onscroll: null,
  addEventListener(): void {},
  removeEventListener(): void {},
  dispatchEvent: (): boolean => true,
} as unknown as typeof visualViewport;

// jsdom implements neither, and CSS transitions are irrelevant to a mount test.
Element.prototype.animate ??= (() => ({
  finished: Promise.resolve(),
  cancel() {},
  addEventListener() {},
  removeEventListener() {},
})) as unknown as Element['animate'];
