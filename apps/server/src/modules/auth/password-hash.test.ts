// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from './password-hash';

// scrypt at N=2^17 is deliberately slow -- that is the point of it -- so these tests need
// more than Vitest's default 5s budget.
const TIMEOUT = 30_000;

describe('hashPassword', () => {
  it(
    'produces a self-describing hash carrying its own parameters',
    async () => {
      const hash = await hashPassword('correct horse battery staple');
      const [format, cost, blockSize, parallelism, salt, digest] = hash.split('$');

      expect(format).toBe('scrypt');
      expect(Number(cost)).toBe(2 ** 17);
      expect(Number(blockSize)).toBe(8);
      expect(Number(parallelism)).toBe(1);
      expect(Buffer.from(salt ?? '', 'base64')).toHaveLength(16);
      expect(Buffer.from(digest ?? '', 'base64')).toHaveLength(64);
    },
    TIMEOUT,
  );

  it(
    'salts, so the same password never yields the same hash twice',
    async () => {
      const [first, second] = await Promise.all([
        hashPassword('the same password'),
        hashPassword('the same password'),
      ]);
      expect(first).not.toBe(second);
    },
    TIMEOUT,
  );

  it(
    'never stores the password in the hash',
    async () => {
      const hash = await hashPassword('sup3rSecretValue!');
      expect(hash).not.toContain('sup3rSecretValue');
    },
    TIMEOUT,
  );
});

describe('verifyPassword', () => {
  it(
    'accepts the right password and rejects the wrong one',
    async () => {
      const hash = await hashPassword('a-perfectly-fine-password');
      await expect(verifyPassword('a-perfectly-fine-password', hash)).resolves.toBe(true);
      await expect(verifyPassword('a-perfectly-fine-passwore', hash)).resolves.toBe(false);
      await expect(verifyPassword('', hash)).resolves.toBe(false);
    },
    TIMEOUT,
  );

  it(
    'is case and whitespace sensitive',
    async () => {
      const hash = await hashPassword('CaseSensitivePassword');
      await expect(verifyPassword('casesensitivepassword', hash)).resolves.toBe(false);
      await expect(verifyPassword(' CaseSensitivePassword', hash)).resolves.toBe(false);
      await expect(verifyPassword('CaseSensitivePassword ', hash)).resolves.toBe(false);
    },
    TIMEOUT,
  );

  it(
    'normalises unicode, so the same characters typed differently still match',
    async () => {
      // "passwörd" with a precomposed o-umlaut vs. o + combining diaeresis. Both are what the
      // user typed as far as they are concerned; the keyboard and OS decide which arrives.
      const precomposed = 'passwörd-with-length';
      const decomposed = 'passwörd-with-length';
      expect(precomposed).not.toBe(decomposed);

      const hash = await hashPassword(precomposed);
      await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
    },
    TIMEOUT,
  );

  it(
    'treats a corrupted or unknown hash as a failed login, never an exception',
    async () => {
      const cases = [
        '',
        'not-a-hash',
        'scrypt$only$four$parts',
        'bcrypt$131072$8$1$c2FsdA==$aGFzaA==',
        'scrypt$0$8$1$c2FsdA==$aGFzaA==',
        'scrypt$131072$8$1$$aGFzaA==',
        'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      ];

      for (const stored of cases) {
        await expect(verifyPassword('any password', stored)).resolves.toBe(false);
      }
    },
    TIMEOUT,
  );
});

describe('needsRehash', () => {
  it(
    'leaves a hash at current parameters alone',
    async () => {
      expect(needsRehash(await hashPassword('current-parameters'))).toBe(false);
    },
    TIMEOUT,
  );

  it('flags weaker parameters and unreadable hashes', () => {
    // A hash from an older release with a lower work factor.
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});
