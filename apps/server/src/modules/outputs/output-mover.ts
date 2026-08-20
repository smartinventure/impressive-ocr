// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import type {
  CollisionPolicy,
  OutputFormat,
  OutputOptions,
  PostAction,
} from '@impressive-ocr/shared';
import { ensureDirectory, exists, moveFile, uniquePath } from '../../infra/fs/file-ops';
import type { Logger } from '../../infra/logger';

/**
 * Moves a finished job's outputs from the scratch directory into the user's output folder,
 * then applies the pipeline's post-action to the source file.
 *
 * The scratch-then-move design is the reason a crash cannot corrupt anyone's data: nothing
 * appears in the output folder until every format has been produced, so a watch folder
 * downstream never sees a half-written .docx.
 */

export interface MovePlanEntry {
  format: OutputFormat;
  /** Absolute path inside the scratch directory. */
  from: string;
  /** Absolute destination inside the user's output folder. */
  to: string;
}

export interface MoveOutputsRequest {
  workDir: string;
  outputRoot: string;
  /** Subfolder mirroring the input tree; empty when mirroring is off. */
  relativeDirectory: string;
  outputStem: string;
  output: OutputOptions;
  logger: Logger;
}

export interface MovedOutput {
  format: OutputFormat;
  path: string;
  bytes: number;
}

/**
 * Work out where each produced file should land.
 *
 * Separated from the IO so the naming and collision rules can be tested without a
 * filesystem — they are the part users notice when they go wrong.
 */
export function planDestinations(
  produced: readonly { format: OutputFormat; relativePath: string }[],
  request: Pick<MoveOutputsRequest, 'workDir' | 'outputRoot' | 'relativeDirectory' | 'outputStem'>,
): MovePlanEntry[] {
  const targetDir = join(request.outputRoot, request.relativeDirectory);

  return produced.map((item) => {
    const extension = extname(item.relativePath);
    // Paddle writes one file per page for multi-page input and names them itself, so a
    // per-page suffix is preserved rather than flattening several pages onto one name.
    const pageSuffix = extractPageSuffix(item.relativePath, request.outputStem);
    const fileName = `${request.outputStem}${pageSuffix}${extension}`;

    return {
      format: item.format,
      from: join(request.workDir, item.relativePath),
      to: join(targetDir, fileName),
    };
  });
}

/**
 * Recover a `_page_003`-style suffix that PaddleOCR added.
 *
 * Without this, a 40-page scan producing 40 Markdown files would collapse onto one
 * destination name and the collision policy would either overwrite 39 of them or number
 * them in whatever order the filesystem happened to return.
 */
function extractPageSuffix(relativePath: string, stem: string): string {
  const base = relativePath.split(/[\\/]/).pop() ?? '';
  const withoutExtension = base.slice(0, base.length - extname(base).length);
  if (!withoutExtension.startsWith(stem)) {
    // Paddle used a name of its own; keep it distinct by appending it wholesale.
    return withoutExtension.length > 0 ? `_${withoutExtension}` : '';
  }
  return withoutExtension.slice(stem.length);
}

export async function moveOutputs(
  produced: readonly { format: OutputFormat; relativePath: string }[],
  request: MoveOutputsRequest,
): Promise<MovedOutput[]> {
  const plan = planDestinations(produced, request);
  const moved: MovedOutput[] = [];

  for (const entry of plan) {
    const destination = await applyCollisionPolicy(entry.to, request.output.collisionPolicy);
    if (destination === null) {
      request.logger.info(
        { format: entry.format, path: entry.to },
        'Output already exists; skipped per the collision policy',
      );
      continue;
    }

    await ensureDirectory(dirname(destination));
    await moveFile(entry.from, destination);
    const stats = await stat(destination);
    moved.push({ format: entry.format, path: destination, bytes: stats.size });
  }

  return moved;
}

/** Resolve the final destination, or null when the file should not be written at all. */
export async function applyCollisionPolicy(
  destination: string,
  policy: CollisionPolicy,
): Promise<string | null> {
  if (!(await exists(destination))) {
    return destination;
  }
  switch (policy) {
    case 'overwrite':
      return destination;
    case 'skip':
      return null;
    case 'suffix':
      return uniquePath(destination);
  }
}

export interface PostActionRequest {
  sourcePath: string;
  inputRoot: string;
  outputRoot: string;
  archivePath: string | undefined;
  action: PostAction;
  logger: Logger;
}

/**
 * Apply the pipeline's after-success action to the original file.
 *
 * Never throws: the OCR succeeded and the outputs are already on disk, so failing to tidy up
 * the source must not turn a completed job into a failed one that gets retried and produces
 * the outputs a second time.
 */
export async function applyPostAction(request: PostActionRequest): Promise<void> {
  const { action, sourcePath, logger } = request;
  if (action === 'keep') {
    return;
  }

  try {
    if (action === 'delete') {
      await rm(sourcePath, { force: true });
      return;
    }

    const root = action === 'move-to-archive' ? request.archivePath : request.outputRoot;
    if (root === undefined) {
      logger.warn({ action }, 'No destination configured for the post-action; keeping source');
      return;
    }

    // Preserve the input folder's structure so a moved original stays findable.
    const relativePath = relative(request.inputRoot, sourcePath);
    const destination = await uniquePath(join(root, relativePath));
    await moveFile(sourcePath, destination);
  } catch (error) {
    logger.error({ err: error, sourcePath, action }, 'Post-action failed; source left in place');
  }
}

/** Remove a job's scratch directory. Best-effort — a leftover temp folder is not worth failing over. */
export async function cleanWorkDir(workDir: string, logger: Logger): Promise<void> {
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, workDir }, 'Could not remove the job scratch directory');
  }
}

/** Files a sidecar actually produced, relative to the scratch directory. */
export async function listProduced(workDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(relative(workDir, full));
      }
    }
  }

  if (await exists(workDir)) {
    await walk(workDir);
  }
  return found.sort();
}
