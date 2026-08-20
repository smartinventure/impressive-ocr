// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createSessionStore } from './session-store';

/** A store with a controllable clock, so expiry can be tested without waiting for it. */
function storeWithClock(idleTimeoutMinutes = 60) {
  let current = 1_000_000;
  const store = createSessionStore({ idleTimeoutMinutes, now: () => current });
  return {
    store,
    advanceMinutes(minutes: number) {
      current += minutes * 60 * 1000;
    },
  };
}

describe('SessionStore', () => {
  it('issues unguessable, distinct tokens', () => {
    const { store } = storeWithClock();
    const first = store.create();
    const second = store.create();

    expect(first.token).not.toBe(second.token);
    expect(first.csrfToken).not.toBe(first.token);
    // 32 random bytes, base64url encoded.
    expect(first.token.length).toBeGreaterThanOrEqual(43);
    expect(first.csrfToken.length).toBeGreaterThanOrEqual(43);
  });

  it('validates a fresh token and rejects anything else', () => {
    const { store } = storeWithClock();
    const session = store.create();

    expect(store.validate(session.token)?.token).toBe(session.token);
    expect(store.validate('some-other-token')).toBeNull();
    expect(store.validate(undefined)).toBeNull();
    expect(store.validate('')).toBeNull();
  });

  it('expires a session left idle past the timeout', () => {
    const { store, advanceMinutes } = storeWithClock(60);
    const session = store.create();

    advanceMinutes(59);
    expect(store.validate(session.token)).not.toBeNull();

    advanceMinutes(61);
    expect(store.validate(session.token)).toBeNull();
  });

  it('slides the expiry forward on each use', () => {
    const { store, advanceMinutes } = storeWithClock(60);
    const session = store.create();

    // Used every 30 minutes: never idle for the full hour, so it should survive well past it.
    for (let index = 0; index < 10; index += 1) {
      advanceMinutes(30);
      expect(store.validate(session.token)).not.toBeNull();
    }

    advanceMinutes(61);
    expect(store.validate(session.token)).toBeNull();
  });

  it('forgets a destroyed session immediately', () => {
    const { store } = storeWithClock();
    const session = store.create();

    store.destroy(session.token);
    expect(store.validate(session.token)).toBeNull();
    // Destroying twice, or destroying nothing, must not throw.
    store.destroy(session.token);
    store.destroy(undefined);
  });

  it('drops every session at once, which is what a password change needs', () => {
    const { store } = storeWithClock();
    const sessions = [store.create(), store.create(), store.create()];

    store.destroyAll();

    for (const session of sessions) {
      expect(store.validate(session.token)).toBeNull();
    }
    expect(store.size).toBe(0);
  });

  it('does not accumulate expired sessions forever', () => {
    const { store, advanceMinutes } = storeWithClock(60);
    for (let index = 0; index < 5; index += 1) store.create();
    expect(store.size).toBe(5);

    advanceMinutes(61);
    // Creating a new session sweeps the dead ones rather than leaking them for process life.
    store.create();
    expect(store.size).toBe(1);
  });
});
