// SPDX-License-Identifier: AGPL-3.0-or-later
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the app keeps its own data.
 *
 * Deliberately platform-native rather than a folder next to the executable: on Windows the
 * install directory is not writable by a standard user, and putting a growing SQLite
 * database and multi-gigabyte model weights under Program Files would fail on first write.
 */

const APP_FOLDER = 'ImpressiveOCR';

export interface AppPaths {
  /** Database, settings, logs. */
  dataDir: string;
  /** Python venv and PaddleOCR model weights — large, and safe to delete and rebuild. */
  runtimeDir: string;
  modelCacheDir: string;
  venvDir: string;
  databaseFile: string;
  logsDir: string;
  /**
   * Scratch space for in-flight jobs. Outputs are written here and moved into the user's
   * output folder only on success, so a crash never leaves a half-written file where
   * downstream tooling would pick it up.
   */
  workDir: string;
}

export function resolveAppPaths(overrideDataDir?: string): AppPaths {
  const dataDir = overrideDataDir ?? defaultDataDir();
  const runtimeDir = join(dataDir, 'runtime');
  return {
    dataDir,
    runtimeDir,
    modelCacheDir: join(runtimeDir, 'models'),
    venvDir: join(runtimeDir, 'venv'),
    databaseFile: join(dataDir, 'impressive-ocr.db'),
    logsDir: join(dataDir, 'logs'),
    workDir: join(tmpdir(), 'impressive-ocr-work'),
  };
}

function defaultDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), APP_FOLDER);
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_FOLDER);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'impressive-ocr');
  }
}

/** Absolute path to the Python interpreter inside our managed virtual environment. */
export function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}
