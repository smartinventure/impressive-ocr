// SPDX-License-Identifier: AGPL-3.0-or-later
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type Logger } from '../logger';
import { ensureCertificate } from './self-signed';

/** RSA keygen is not fast; these need more than Vitest's default budget. */
const TIMEOUT = 60_000;

let directory: string;
let logger: Logger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'impressive-ocr-tls-'));
  logger = createLogger({ level: 'silent', pretty: false });
});

afterEach(() => {
  // The temp directory is left for the OS to reap; certificates here are throwaway.
});

describe('ensureCertificate', () => {
  it(
    'creates a usable certificate and key pair',
    async () => {
      const material = await ensureCertificate({ directory, logger });

      expect(material.generated).toBe(true);
      expect(material.certificate).toContain('BEGIN CERTIFICATE');
      expect(material.key).toContain('PRIVATE KEY');

      // Written to disk, not just returned.
      await expect(readFile(material.certificatePath, 'utf8')).resolves.toContain('CERTIFICATE');
      await expect(readFile(material.keyPath, 'utf8')).resolves.toContain('PRIVATE KEY');
    },
    TIMEOUT,
  );

  it(
    'names localhost and 127.0.0.1 in the SAN, which is all browsers actually check',
    async () => {
      const material = await ensureCertificate({ directory, logger });
      const parsed = new X509Certificate(material.certificate);

      // commonName is ignored by every current browser; a certificate without these entries
      // is rejected outright rather than merely untrusted.
      expect(parsed.subjectAltName).toContain('DNS:localhost');
      expect(parsed.subjectAltName).toContain('IP Address:127.0.0.1');
    },
    TIMEOUT,
  );

  it(
    'is valid now and for a long time yet',
    async () => {
      const material = await ensureCertificate({ directory, logger });
      const parsed = new X509Certificate(material.certificate);

      const now = Date.now();
      expect(new Date(parsed.validFrom).getTime()).toBeLessThanOrEqual(now + 60_000);
      const daysValid = (new Date(parsed.validTo).getTime() - now) / (24 * 60 * 60 * 1000);
      expect(daysValid).toBeGreaterThan(700);
    },
    TIMEOUT,
  );

  it(
    'reuses the pair on a second call rather than churning the fingerprint',
    async () => {
      const first = await ensureCertificate({ directory, logger });
      const second = await ensureCertificate({ directory, logger });

      expect(second.generated).toBe(false);
      // Regenerating every boot would re-trigger the browser warning each time, training
      // users to click through it.
      expect(second.certificate).toBe(first.certificate);
    },
    TIMEOUT,
  );

  it(
    'replaces a certificate that is close to expiring',
    async () => {
      const first = await ensureCertificate({ directory, logger });

      // Two years minus a fortnight from now: inside the 30-day renewal window.
      const almostExpired = new Date(Date.now() + (730 - 14) * 24 * 60 * 60 * 1000);
      const second = await ensureCertificate({ directory, logger, now: () => almostExpired });

      expect(second.generated).toBe(true);
      expect(second.certificate).not.toBe(first.certificate);
    },
    TIMEOUT,
  );

  it(
    'replaces an unreadable certificate instead of serving it',
    async () => {
      const first = await ensureCertificate({ directory, logger });
      await writeFile(first.certificatePath, 'this is not a certificate', 'utf8');

      const second = await ensureCertificate({ directory, logger });

      expect(second.generated).toBe(true);
      expect(new X509Certificate(second.certificate).subject).toBeTruthy();
    },
    TIMEOUT,
  );
});
