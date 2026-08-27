// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

/**
 * A stable identifier for this machine, so three personal seats can be counted.
 *
 * Derived from the operating system's own installation identifier rather than generated and
 * stored by us. A random identifier we wrote to disk would be lost on every reinstall, and a
 * user who reformatted their laptop would burn a seat each time — which turns a courtesy
 * limit into a support queue.
 *
 * **Hashed before it leaves the machine, and salted with a constant.** The raw values below
 * are stable, globally unique identifiers for a person's computer; the licence server has no
 * need for one, only for something that is the same on Tuesday as it was on Monday. Hashing
 * means a leak of the licence database cannot be correlated against any other system that
 * knows the same machine GUID.
 *
 * Falls back to the hostname when nothing better is available. Weaker — two machines in a
 * fleet imaged from the same template can share it — but it fails in the direction of
 * consuming a seat rather than of blocking someone, and it never throws.
 */

const run = promisify(execFile);

/**
 * Domain separation. Without it the hash is a plain SHA-256 of a machine GUID, which is
 * trivially reversible by anyone holding a list of candidate GUIDs.
 */
const SALT = 'impressive-ocr.machine-id.v1';

/** Machine identity is fixed for the process lifetime; reading it repeatedly is waste. */
let cached: string | null = null;

export async function machineId(): Promise<string> {
  if (cached !== null) {
    return cached;
  }
  const raw = (await rawMachineIdentifier()) ?? hostname();
  cached = createHash('sha256').update(`${SALT}:${raw}`).digest('hex').slice(0, 32);
  return cached;
}

/** Exposed for tests, which must not depend on the machine they run on. */
export function resetMachineIdCache(): void {
  cached = null;
}

async function rawMachineIdentifier(): Promise<string | null> {
  try {
    switch (process.platform) {
      case 'win32':
        return await windowsMachineGuid();
      case 'darwin':
        return await macPlatformUuid();
      default:
        return await linuxMachineId();
    }
  } catch {
    // Every branch below reads something that a hardened or containerised system may simply
    // not have. The hostname fallback is the answer, not an error.
    return null;
  }
}

/** `HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid`, written once at Windows setup. */
async function windowsMachineGuid(): Promise<string | null> {
  const { stdout } = await run(
    'reg',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
    { windowsHide: true },
  );
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout);
  return match?.[1] ?? null;
}

/** `IOPlatformUUID`, tied to the hardware rather than to the installed system. */
async function macPlatformUuid(): Promise<string | null> {
  const { stdout } = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * `/etc/machine-id`, with `/var/lib/dbus/machine-id` as the older spelling.
 *
 * Worth knowing: a container inherits its image's value unless one is generated at build
 * time, so several containers from one image count as one machine. For the personal tier
 * that is the forgiving direction, and the commercial tier is not seat-limited here.
 */
async function linuxMachineId(): Promise<string | null> {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      if (value !== '') {
        return value;
      }
    } catch {
      // Try the next one.
    }
  }
  return null;
}
