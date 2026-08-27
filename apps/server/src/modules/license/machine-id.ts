// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * A stable identifier for this installation, so seats can be counted.
 *
 * Two sources, in order, and the order is the whole design:
 *
 * 1. **The operating system's own installation identifier** — MachineGuid, IOPlatformUUID,
 *    `/etc/machine-id`. Preferred because it survives reinstalling the application: a user who
 *    reformats and reinstalls keeps their seat instead of burning a second one.
 * 2. **A random identifier stored in the data directory.** Used when the first is unavailable,
 *    which is the normal case in a container.
 *
 * **There is deliberately no hostname fallback.** That was the first version and it is wrong
 * in exactly the environment that matters: a Debian slim image ships `/etc/machine-id` as an
 * empty file — systemd writes it at boot, and no container boots — so the Linux branch finds
 * nothing, and Docker sets the hostname to the container id, which changes on every
 * `docker run`. Every recreate would claim a fresh seat and a three-seat licence would be
 * exhausted by the third restart. The licence server's own documentation warns about this:
 * "It must stay the same across restarts, or every restart burns a seat."
 *
 * The data directory is the right home for the fallback because it is the volume: the whole
 * point of running this in a container is that `/data` is mounted and outlives the container.
 *
 * **The OS identifier is hashed with a salt before it leaves the machine.** Those values are
 * stable, globally unique identifiers for a person's computer, and the licence server needs
 * only something that is the same tomorrow as it was today. Hashing means a leak of the
 * licence database cannot be correlated against any other system that knows the same GUID.
 */

const run = promisify(execFile);

/**
 * Domain separation. Without it the hash is a plain SHA-256 of a machine GUID, which is
 * trivially reversible by anyone holding a list of candidate GUIDs.
 */
const SALT = 'impressive-ocr.machine-id.v1';

/** Where the fallback identifier is kept, relative to the data directory. */
const FALLBACK_FILE = 'machine-id';

/** Machine identity is fixed for the process lifetime; reading it repeatedly is waste. */
let cached: string | null = null;

/**
 * @param dataDir Where the fallback identifier is stored when the OS has none. In a container
 *   this is the mounted volume, which is what makes the value survive `docker run` again.
 */
export async function machineId(dataDir: string): Promise<string> {
  if (cached !== null) {
    return cached;
  }

  const fromSystem = await rawMachineIdentifier();
  cached =
    fromSystem === null
      ? await persistedMachineId(dataDir)
      : createHash('sha256').update(`${SALT}:${fromSystem}`).digest('hex').slice(0, 32);

  return cached;
}

/** Exposed for tests, which must not depend on the machine they run on. */
export function resetMachineIdCache(): void {
  cached = null;
}

/**
 * Read the stored identifier, generating one the first time.
 *
 * A write failure returns the generated value anyway rather than throwing. That degrades to
 * the old behaviour — a new seat per restart — which is bad, but it is better than an
 * activation screen that cannot be completed at all because a volume is read-only.
 */
async function persistedMachineId(dataDir: string): Promise<string> {
  const file = join(dataDir, FALLBACK_FILE);

  try {
    const stored = (await readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{32}$/.test(stored)) {
      return stored;
    }
  } catch {
    // Not written yet, which is the first-run case.
  }

  const generated = randomBytes(16).toString('hex');
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, `${generated}\n`, 'utf8');
  } catch {
    // Read-only volume, or no permission. See the note above.
  }
  return generated;
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
    // Every branch below reads something a hardened or containerised system may not have.
    // The stored fallback is the answer, not an error.
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
 * Returns null far more often than it looks: on a Debian slim image the file exists but is
 * **empty**, because systemd populates it at boot and a container never boots. The emptiness
 * check is therefore the important line here, not a defensive afterthought — without it every
 * container would report the same blank identifier and share one seat.
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
