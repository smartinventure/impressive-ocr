// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * scrypt parameters, following the OWASP Password Storage Cheat Sheet.
 *
 * scrypt rather than Argon2id — which OWASP lists first — because Argon2 means a native
 * module, and this codebase already ships an Electron desktop build that has to rebuild
 * better-sqlite3 for Electron's ABI on three platforms. A second native dependency would
 * compound that for a single admin password. scrypt is in `node:crypto`, needs no build step,
 * and is explicitly OWASP-approved at these parameters.
 *
 * N is the work factor and dominates both cost and memory: 2^17 needs roughly 128 MB, which
 * is why `maxmem` has to be raised from Node's 32 MB default or the call simply throws.
 */
const SCRYPT_COST = 2 ** 17;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** 128 MiB with headroom; scrypt needs about 128 * N * r bytes. */
const MAX_MEMORY = 192 * 1024 * 1024;

/** Identifies the algorithm and parameters, so they can change without orphaning old hashes. */
const FORMAT = 'scrypt';

export class PasswordHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordHashError';
  }
}

/**
 * Hash a password into a self-describing string:
 * `scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>`.
 *
 * Storing the parameters alongside the digest means a future increase in the work factor can
 * still verify — and transparently upgrade — passwords hashed under the old settings.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(password, salt, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelism: SCRYPT_PARALLELISM,
  });

  return [
    FORMAT,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed or unknown-format hash rather than throwing: a corrupted row
 * must read as "wrong password", never as an exception a caller might mistake for success.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;

  let derived: Buffer;
  try {
    derived = await deriveKey(password, parsed.salt, parsed.parameters);
  } catch {
    return false;
  }

  if (derived.length !== parsed.hash.length) return false;
  // Constant time: a length-independent early return would leak how much of the digest
  // matched, one byte at a time.
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Whether a stored hash was produced with parameters weaker than today's.
 *
 * Callers re-hash on the next successful login, which is the only moment the plaintext is
 * available to do it with.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (parsed === null) return true;
  return (
    parsed.parameters.cost < SCRYPT_COST ||
    parsed.parameters.blockSize < SCRYPT_BLOCK_SIZE ||
    parsed.parameters.parallelism < SCRYPT_PARALLELISM
  );
}

interface ScryptParameters {
  cost: number;
  blockSize: number;
  parallelism: number;
}

/**
 * Promise wrapper around `crypto.scrypt`.
 *
 * Hand-written rather than `promisify`: the overload that takes an options object is scrypt's
 * four-argument form, which `promisify`'s type definitions do not cover, and the alternative
 * would be casting the result to silence the compiler.
 *
 * The password is NFKC-normalised first. The same accented character can arrive as one code
 * point or as a base plus a combining mark depending on the keyboard and operating system,
 * and without normalising, a password typed on a Mac could fail to verify on Windows.
 */
function deriveKey(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelism,
        maxmem: MAX_MEMORY,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

interface ParsedHash {
  parameters: ScryptParameters;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;

  const [format, cost, blockSize, parallelism, salt, hash] = parts;
  if (format !== FORMAT) return null;

  const parameters = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism),
  };
  if (!Object.values(parameters).every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }
  if (salt === undefined || hash === undefined) return null;

  const saltBytes = Buffer.from(salt, 'base64');
  const hashBytes = Buffer.from(hash, 'base64');
  if (saltBytes.length === 0 || hashBytes.length === 0) return null;

  return { parameters, salt: saltBytes, hash: hashBytes };
}
