// SPDX-License-Identifier: AGPL-3.0-or-later
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Decides where the runtime, models and database live.
 *
 * Split out of `server-host.ts` because it is a decision with three inputs and a real
 * consequence, not a path expression. The runtime is **8 GB or more** — a Python environment,
 * PaddleOCR's models, the inference engine and its weights — and where that lands is the
 * difference between an install that works and one that fills the system drive.
 *
 * Three sources, most specific first:
 *
 * 1. `IMPRESSIVE_OCR_DATA_DIR`, matching the headless server, so one variable moves either
 *    build and a support answer does not have to ask which one is running.
 * 2. A location the user chose, remembered beside the app's own settings.
 * 3. The platform default below.
 */

/** Remembered in `userData` itself, which is the one place that cannot be relocated. */
const LOCATION_FILE = 'data-location.json';

interface StoredLocation {
  dataDir?: string;
}

/**
 * The platform default.
 *
 * On Windows this is **Local, not Roaming**, and that is the whole reason this function
 * exists. Electron's `userData` sits under `AppData\\Roaming`, which in a managed environment
 * is synchronised to a file server at every logon: eight gigabytes of CUDA libraries and
 * model weights is precisely what must never go there, and it is not something a user would
 * discover until their profile stopped syncing. Microsoft's own guidance puts caches and
 * machine-specific binaries in `AppData\\Local`, and everything here is both.
 *
 * macOS and Linux need no such care — `Application Support` and `~/.config` are per-machine
 * already — so those stay on Electron's own location and keep the tray's "open data folder"
 * pointing somewhere users recognise.
 */
export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local');
    return join(local, app.getName(), 'data');
  }
  return join(app.getPath('userData'), 'data');
}

/** Where the backend should keep everything, honouring the environment and the user's choice. */
export function resolveDataDir(): string {
  const fromEnvironment = process.env.IMPRESSIVE_OCR_DATA_DIR?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== '' && isAbsolute(fromEnvironment)) {
    return fromEnvironment;
  }

  const chosen = readChosenDataDir();
  return chosen ?? defaultDataDir();
}

/**
 * The location the user picked, or null.
 *
 * Never throws: an unreadable or malformed file means the default, because failing to start
 * the app over a preference would be a far worse outcome than ignoring one.
 */
export function readChosenDataDir(): string | null {
  try {
    const raw = readFileSync(locationFile(), 'utf8');
    const parsed = JSON.parse(raw) as StoredLocation;
    const value = parsed.dataDir?.trim();
    return value !== undefined && value !== '' && isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remember a location for the next start, or forget it when given null.
 *
 * Deliberately does not move anything. The runtime is gigabytes and is in use by a running
 * Python process, so relocating it live is not something to attempt behind a settings toggle;
 * the new location is installed into on the next start instead.
 */
export function writeChosenDataDir(dataDir: string | null): void {
  const file = locationFile();
  mkdirSync(dirname(file), { recursive: true });

  const value: StoredLocation = dataDir === null ? {} : { dataDir };
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function locationFile(): string {
  return join(app.getPath('userData'), LOCATION_FILE);
}
