// SPDX-License-Identifier: AGPL-3.0-or-later
import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
// selfsigned 2.x, which is built on node-forge. Version 5 rewrote the internals onto
// @peculiar/x509 and throws "Cannot get schema for 'BasicConstraints' target" here for even a
// bare generate() call - its ASN.1 decorator metadata does not survive this dependency tree.
import { generate } from 'selfsigned';
import { ensureDirectory } from '../fs/file-ops';
import type { Logger } from '../logger';

/**
 * A self-signed certificate for serving the UI over https on a local network.
 *
 * This is not a substitute for a real certificate. Browsers will show a full-page warning the
 * first time, because nothing vouches for this key but itself. It exists so that enabling a
 * password never silently downgrades to sending it in the clear: a warning the user clicks
 * through once is recoverable, a password sniffed off the wire is not.
 *
 * Anyone running this beyond a trusted LAN should point a reverse proxy with a real
 * certificate at the loopback port instead.
 */

export interface TlsMaterial {
  certificatePath: string;
  keyPath: string;
  certificate: string;
  key: string;
  /** True when this call created the files, so the caller can tell the user once. */
  generated: boolean;
}

export interface EnsureCertificateOptions {
  /** Directory the pair lives in; created if absent. */
  directory: string;
  logger: Logger;
  /** Injectable for tests. */
  now?: () => Date;
}

const CERTIFICATE_FILE = 'server-cert.pem';
const KEY_FILE = 'server-key.pem';

/** Two years: long enough not to be a chore, short enough to rotate within a product lifetime. */
const VALIDITY_DAYS = 730;

/** Regenerate this far ahead of expiry, so a long-running install never serves an expired cert. */
const RENEW_BEFORE_DAYS = 30;

/**
 * Load the existing certificate, or make one.
 *
 * Reuses what is on disk whenever it is still valid: regenerating on every boot would change
 * the fingerprint each time, and users would face the browser warning again and again rather
 * than trusting it once.
 */
export async function ensureCertificate(options: EnsureCertificateOptions): Promise<TlsMaterial> {
  const now = options.now ?? ((): Date => new Date());
  const certificatePath = join(options.directory, CERTIFICATE_FILE);
  const keyPath = join(options.directory, KEY_FILE);

  const existing = await readExisting(certificatePath, keyPath, now());
  if (existing !== null) {
    return { certificatePath, keyPath, ...existing, generated: false };
  }

  await ensureDirectory(options.directory);

  const notBefore = now();
  const notAfter = new Date(notBefore.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const machine = hostname();

  const pems = generate([{ name: 'commonName', value: machine }], {
    keySize: 2048,
    days: VALIDITY_DAYS,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        // Modern browsers ignore commonName entirely and match on SAN only, so every name
        // the server might be reached by has to be listed here or the certificate is
        // rejected outright rather than merely untrusted.
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 2, value: machine },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  });

  await writeFile(certificatePath, pems.cert, { encoding: 'utf8', mode: 0o600 });
  // 0600: the private key is the whole secret. On Windows the mode is largely advisory, but
  // it costs nothing and is real protection everywhere else.
  await writeFile(keyPath, pems.private, { encoding: 'utf8', mode: 0o600 });

  options.logger.warn(
    { certificatePath, validUntil: notAfter.toISOString(), fingerprint: pems.fingerprint },
    'Generated a self-signed certificate; browsers will warn until it is trusted once',
  );

  return {
    certificatePath,
    keyPath,
    certificate: pems.cert,
    key: pems.private,
    generated: true,
  };
}

/** Returns the stored pair when it exists, parses and is not near expiry. */
async function readExisting(
  certificatePath: string,
  keyPath: string,
  now: Date,
): Promise<{ certificate: string; key: string } | null> {
  let certificate: string;
  let key: string;
  try {
    [certificate, key] = await Promise.all([
      readFile(certificatePath, 'utf8'),
      readFile(keyPath, 'utf8'),
    ]);
  } catch {
    return null;
  }

  try {
    const parsed = new X509Certificate(certificate);
    const expires = new Date(parsed.validTo);
    const renewAt = new Date(expires.getTime() - RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000);
    // A cert that is unparseable, expired, or about to expire is replaced rather than served.
    if (Number.isNaN(expires.getTime()) || now >= renewAt) return null;
  } catch {
    return null;
  }

  return { certificate, key };
}
