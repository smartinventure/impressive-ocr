// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../infra/logger';

/**
 * Repairs a half-downloaded PaddleOCR model cache.
 *
 * PaddleOCR decides a model is cached by checking that its directory exists — not that the
 * weights inside are complete. So an interrupted download leaves an `inference.pdiparams`
 * only partly written (PaddleOCR names it `*.incomplete` while in flight), and every
 * subsequent run logs "Model files already exist. Using cached files" and then dies with
 * "No valid PaddlePaddle model found". The cache never heals itself, and the error names
 * neither the model nor the download.
 *
 * Interrupted downloads are not an edge case here: the files are hundreds of megabytes, and
 * laptops sleep, networks drop and disks fill. So the incomplete directories are removed
 * before each install, which makes the next attempt fetch them cleanly.
 */

/** Suffix PaddleOCR gives a weights file while it is still downloading. */
const INCOMPLETE_SUFFIX = '.incomplete';

/** Where PaddleOCR keeps downloaded weights inside `PADDLE_PDX_CACHE_HOME`. */
const MODELS_SUBDIRECTORY = 'official_models';

export interface CacheRepairResult {
  /** Model directories removed because their weights were incomplete. */
  removed: string[];
  /** Directories that looked complete and were kept. */
  kept: number;
}

export async function repairModelCache(
  cacheHome: string,
  logger: Logger,
): Promise<CacheRepairResult> {
  const modelsDir = join(cacheHome, MODELS_SUBDIRECTORY);
  const result: CacheRepairResult = { removed: [], kept: 0 };

  let entries: string[];
  try {
    entries = await readdir(modelsDir);
  } catch {
    // No cache yet — nothing to repair, and the first install is the common case.
    return result;
  }

  for (const name of entries) {
    const modelDir = join(modelsDir, name);
    if (!(await isDirectory(modelDir))) {
      continue;
    }
    if (await hasIncompleteDownload(modelDir)) {
      // The whole directory goes, not just the partial file: PaddleOCR's "does it exist"
      // check is on the directory, so leaving it behind would keep the cache poisoned.
      await rm(modelDir, { recursive: true, force: true });
      result.removed.push(name);
      logger.warn({ model: name }, 'Removed an incompletely downloaded model so it refetches');
    } else {
      result.kept += 1;
    }
  }

  return result;
}

async function hasIncompleteDownload(modelDir: string): Promise<boolean> {
  try {
    const files = await readdir(modelDir);
    return files.some((file) => file.endsWith(INCOMPLETE_SUFFIX));
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Exported for tests, so the suffix cannot drift from PaddleOCR's without a failure. */
export const INTERNALS = { INCOMPLETE_SUFFIX, MODELS_SUBDIRECTORY };
