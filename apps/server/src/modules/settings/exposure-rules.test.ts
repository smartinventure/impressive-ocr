// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { appSettingsSchema, type AppSettings } from '@impressive-ocr/shared';
import { assertSafeExposure, SettingsValidationError } from './settings-service';

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return appSettingsSchema.parse(patch);
}

const PROTECTED = { hasPassword: true };
const UNPROTECTED = { hasPassword: false };

describe('assertSafeExposure', () => {
  describe('on loopback', () => {
    it('allows plain http with no authentication at all', () => {
      // Traffic to 127.0.0.1 never reaches a network interface, so requiring a certificate
      // here would only teach users to click through browser warnings.
      const local = settings({ bindAddress: '127.0.0.1', authEnabled: false, scheme: 'http' });
      expect(() => assertSafeExposure(local, UNPROTECTED)).not.toThrow();
    });
  });

  describe('on a network address', () => {
    const exposed = { bindAddress: '0.0.0.0' } as const;

    it('rejects it when authentication is off', () => {
      const value = settings({ ...exposed, authEnabled: false, scheme: 'https' });
      expect(() => assertSafeExposure(value, PROTECTED)).toThrow(SettingsValidationError);
    });

    it('rejects it when authentication is on but no password exists', () => {
      // The hole this closes: authEnabled used to be nothing more than permission to bind to
      // the network, with no credential behind it.
      const value = settings({ ...exposed, authEnabled: true, scheme: 'https' });
      expect(() => assertSafeExposure(value, UNPROTECTED)).toThrow(/[Ss]et a password/);
    });

    it('rejects plain http even with a password set', () => {
      const value = settings({ ...exposed, authEnabled: true, scheme: 'http' });
      expect(() => assertSafeExposure(value, PROTECTED)).toThrow(/https/);
    });

    it('allows it only with authentication, a password and https together', () => {
      const value = settings({ ...exposed, authEnabled: true, scheme: 'https' });
      expect(() => assertSafeExposure(value, PROTECTED)).not.toThrow();
    });
  });

  it('names the missing piece, so the UI can tell the user what to fix', () => {
    const noAuth = settings({ bindAddress: '0.0.0.0', authEnabled: false });
    expect(() => assertSafeExposure(noAuth, UNPROTECTED)).toThrow(/[Ee]nable authentication/);
  });
});
