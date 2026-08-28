// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  shell: { openExternal },
  BrowserWindow: class {},
}));

const { isSameOrigin, openIfWebAddress } = await import('./main-window');

/**
 * What the window may hand to the operating system.
 *
 * `shell.openExternal` asks the OS to open a URL with whatever is registered for its scheme.
 * For `http(s)` that is a browser; for `file://` it is whatever opens that file, which for the
 * wrong target means launching a program. `setWindowOpenHandler` had always checked the scheme
 * and `will-navigate` had not, so one of the two paths passed every scheme straight through.
 */

describe('openIfWebAddress', () => {
  it.each(['https://example.com', 'http://example.com/page?q=1'])('opens %s', (url) => {
    openExternal.mockClear();

    openIfWebAddress(url);

    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id',
    'javascript:alert(1)',
    'smb://host/share',
  ])('refuses %s', (url) => {
    openExternal.mockClear();

    openIfWebAddress(url);

    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('isSameOrigin', () => {
  it('recognises the application itself', () => {
    expect(isSameOrigin('http://127.0.0.1:8084/pipelines', 'http://127.0.0.1:8084')).toBe(true);
  });

  it('treats a different port as foreign', () => {
    // The app moves port when one is taken, so this is a real distinction rather than theory.
    expect(isSameOrigin('http://127.0.0.1:8085/', 'http://127.0.0.1:8084')).toBe(false);
  });

  it('treats a target it cannot parse as foreign', () => {
    // Throwing inside a `will-navigate` listener has nowhere sensible to go.
    expect(isSameOrigin('not a url', 'http://127.0.0.1:8084')).toBe(false);
  });
});
