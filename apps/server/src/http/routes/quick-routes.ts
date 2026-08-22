// SPDX-License-Identifier: AGPL-3.0-or-later
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  QUICK_UPLOAD_MAX_FILES,
  quickOptionsSchema,
  startQuickRunRequestSchema,
} from '@impressive-ocr/shared';
import { createId } from '../../infra/ids';
import { QuickRunError } from '../../modules/quick/quick-run-service';
import { archiveFileName, buildResultArchive } from '../../modules/quick/result-archive';
import type { AppServices } from '../../app-services';
import type { AppFastify } from '../fastify-types';
import { HttpError } from '../errors';

/**
 * Quick Mode: OCR a few files once, without configuring a watched folder.
 *
 * Two shapes, because a browser cannot hand the server a usable file path. Picking files on
 * the server is the right thing on a desktop and costs no copying; uploading is the only
 * option when the UI is not on the same machine, and then the results have to come back over
 * HTTP rather than being written somewhere the user cannot reach.
 */
export function registerQuickRoutes(app: AppFastify, services: AppServices): void {
  const { quick, quickStore, jobs, pipelines } = services;

  /**
   * Stage uploaded files.
   *
   * Separate from starting the run so the upload can be shown progressing, and so a run is
   * never created for an upload that failed halfway.
   */
  app.post('/api/quick/uploads', async (request) => {
    if (!request.isMultipart()) {
      throw new HttpError(415, 'expected-multipart', 'Send the files as multipart/form-data.');
    }

    const runId = createId();
    const { inputDir } = await quickStore.create(runId);
    const staged: string[] = [];

    try {
      for await (const part of request.files()) {
        if (staged.length >= QUICK_UPLOAD_MAX_FILES) {
          throw new HttpError(
            413,
            'too-many-files',
            `A single run takes at most ${QUICK_UPLOAD_MAX_FILES} files.`,
          );
        }

        // The client controls this name. `basename` alone is not enough on Windows, where a
        // backslash is also a separator, so both are stripped before it touches a path.
        const safeName = sanitizeUploadName(part.filename, staged.length);
        const destination = join(inputDir, safeName);

        await streamPipeline(part.file, createWriteStream(destination));
        if (part.file.truncated) {
          throw new HttpError(413, 'file-too-large', `${part.filename} is too large.`);
        }
        staged.push(destination);
      }
    } catch (error) {
      // Never leave a half-finished upload occupying disk until the sweeper notices it.
      await quickStore.discard(runId);
      throw error;
    }

    if (staged.length === 0) {
      await quickStore.discard(runId);
      throw new HttpError(400, 'no-files', 'No files were uploaded.');
    }

    return { uploadId: runId, files: staged.map((path) => path.slice(inputDir.length + 1)) };
  });

  app.post('/api/quick/runs', async (request) => {
    const body = startQuickRunRequestSchema.parse(request.body);

    try {
      if (body.source === 'upload') {
        const runId = body.uploadId as string;
        const { inputDir } = quickStore.directoriesFor(runId);
        const files = await listStagedFiles(inputDir);

        return await quick.start({
          source: 'upload',
          files,
          outputPath: null,
          options: quickOptionsSchema.parse(body.options),
          runId,
        });
      }

      return await quick.start({
        source: 'server',
        files: body.files,
        outputPath: body.outputPath ?? null,
        options: quickOptionsSchema.parse(body.options),
      });
    } catch (error) {
      if (error instanceof QuickRunError) {
        throw new HttpError(400, error.reason, error.message);
      }
      throw error;
    }
  });

  /** Progress for one run, derived from its jobs exactly as a pipeline's is. */
  app.get('/api/quick/runs/:pipelineId', (request) => {
    const { pipelineId } = request.params as { pipelineId: string };
    const pipeline = pipelines.get(pipelineId);
    if (pipeline === null) {
      throw new HttpError(404, 'not-found', 'That run no longer exists.');
    }

    return {
      pipelineId,
      stats: pipeline.stats,
      jobs: jobs.list({ pipelineId, limit: 200, offset: 0 }).items,
    };
  });

  app.post('/api/quick/runs/:pipelineId/cancel', (request) => {
    const { pipelineId } = request.params as { pipelineId: string };

    return { cancelled: quick.cancel(pipelineId) };
  });

  /**
   * Download everything a run produced, as one ZIP.
   *
   * Always a ZIP: one button with one predictable result beats saving a click on the
   * occasions when there happens to be exactly one output file.
   */
  app.get('/api/quick/runs/:pipelineId/download', async (request, reply) => {
    const { pipelineId } = request.params as { pipelineId: string };
    const outputs = quick.outputsFor(pipelineId);

    if (outputs.length === 0) {
      throw new HttpError(404, 'nothing-to-download', 'This run has not produced anything yet.');
    }

    // Logged either side of the work, so the log viewer shows a download progressing rather
    // than a gap between the run finishing and a file appearing.
    request.log.info({ pipelineId, files: outputs.length }, 'Preparing results ZIP');

    const archive = await buildResultArchive(outputs);
    if (archive.missing.length > 0) {
      request.log.warn(
        { pipelineId, missing: archive.missing.length },
        'Some Quick Mode outputs were gone at download time',
      );
    }
    archive.stream.once('end', () => {
      request.log.info({ pipelineId, entries: archive.included }, 'Results ZIP written');
    });

    return (
      reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${archiveFileName(outputs)}"`)
        // No length header: the archive is streamed, and buffering it to measure would defeat
        // the point on a large run.
        .send(archive.stream)
    );
  });

  app.delete('/api/quick/runs/:pipelineId', async (request) => {
    const { pipelineId } = request.params as { pipelineId: string };
    const runId = z
      .string()
      .min(1)
      .parse((request.query as { runId?: string }).runId ?? '');

    quick.cancel(pipelineId);
    await quickStore.discard(runId);
    return { ok: true };
  });
}

/**
 * Make a client-supplied filename safe to join onto a path.
 *
 * Uploaded names are attacker-controlled. Stripping both separators and any run of dots means
 * the result can only ever be a leaf inside the staging directory.
 */
function sanitizeUploadName(filename: string, index: number): string {
  const cleaned = filename
    .replace(/[\\/]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s-]+/, '')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what to drop
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim();

  return cleaned.length > 0 ? cleaned : `upload-${index + 1}`;
}

async function listStagedFiles(inputDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const names = await readdir(inputDir);
    return names.map((name) => join(inputDir, name));
  } catch {
    return [];
  }
}
