// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * Well above Vitest's 5s default, because password hashing is *meant* to be slow.
     *
     * scrypt at N=2^17 costs roughly 0.6s per call on a warm machine, and the auth tests
     * make several. One of them measured 4.2s in isolation and then failed intermittently in
     * the full run, where workers compete for CPU — a timing artefact that looks exactly like
     * a real auth regression when it appears in CI.
     *
     * Raising it trades slower detection of a genuine hang for not crying wolf about the one
     * thing in this codebase that is deliberately expensive.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
