// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import { z } from 'zod';
import { FINISHED_JOB_STATES, jobStateSchema, paginationQuerySchema } from '@impressive-ocr/shared';
import type { JobState } from '@impressive-ocr/shared';
import { HttpError, notFound } from '../errors';
import type { AppServices } from '../../app-services';

const jobListQuerySchema = paginationQuerySchema.extend({
  pipelineId: z.string().min(1).optional(),
  state: jobStateSchema.optional(),
});

/** Narrows a clear to one finished state, so clearing failures keeps the successes. */
const clearJobsQuerySchema = z.object({ state: jobStateSchema.optional() });

function isFinished(state: JobState): boolean {
  return (FINISHED_JOB_STATES as readonly JobState[]).includes(state);
}

export function registerJobRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/jobs', (request) => {
    const query = jobListQuerySchema.parse(request.query);
    const { items, total } = services.jobs.list({
      pipelineId: query.pipelineId,
      state: query.state,
      limit: query.limit,
      offset: query.offset,
    });
    // Named here rather than in the browser: the client's pipeline list excludes Quick
    // Mode's hidden pipelines, so it cannot resolve those names itself.
    const enriched = items.map((job) => {
      const pipeline = services.pipelines.get(job.pipelineId);
      return {
        ...job,
        pipelineName: pipeline?.name ?? 'Unknown',
        pipelineKind: pipeline?.kind ?? 'watched',
      };
    });

    return { items: enriched, total, limit: query.limit, offset: query.offset };
  });

  /**
   * Clear finished job history.
   *
   * History only. Queued and running jobs are refused outright rather than skipped quietly:
   * a button that says "clear" and leaves rows behind with no explanation is worse than one
   * that says what it will not do. Nothing on disk is touched -- the documents and everything
   * written from them outlive their rows, and the content hashes that stop a watched pipeline
   * re-reading a file it has already done are kept deliberately, so clearing the list does not
   * quietly re-queue a folder.
   */
  /**
   * How many rows a clear would take.
   *
   * Registered before `/api/jobs/:id` for readability; Fastify prefers a static segment over a
   * parametric one either way. Asked when the confirmation opens, because the list the browser
   * holds is capped and paged -- counting what it happens to have loaded would put a number on
   * the dialog that is wrong exactly when it matters, on a long history.
   */
  app.get('/api/jobs/clearable', (request) => {
    const query = clearJobsQuerySchema.parse(request.query);
    if (query.state !== undefined && !isFinished(query.state)) {
      return { clearable: 0 };
    }
    return { clearable: services.jobs.countFinished(query.state) };
  });

  app.delete('/api/jobs', (request) => {
    const query = clearJobsQuerySchema.parse(request.query);

    if (query.state !== undefined && !isFinished(query.state)) {
      throw new HttpError(
        400,
        'job-not-clearable',
        'Only finished jobs can be cleared. Cancel a job first to stop it.',
      );
    }

    return { cleared: services.jobs.clearFinished(query.state) };
  });

  app.get('/api/jobs/:id', (request) => {
    const { id } = request.params as { id: string };
    const job = services.jobs.find(id);
    if (job === null) {
      throw notFound('Job');
    }
    return job;
  });

  /** The page-by-page timeline shown in the job detail drawer. */
  app.get('/api/jobs/:id/events', (request) => {
    const { id } = request.params as { id: string };
    if (services.jobs.find(id) === null) {
      throw notFound('Job');
    }
    return services.jobs.eventsFor(id);
  });

  /**
   * Retry a job that failed or was quarantined.
   *
   * Clears the backoff so it runs on the next tick rather than waiting — the user pressing
   * the button *is* the signal that whatever was wrong has been dealt with.
   */
  app.post('/api/jobs/:id/retry', (request) => {
    const { id } = request.params as { id: string };
    const job = services.jobs.find(id);
    if (job === null) {
      throw notFound('Job');
    }
    if (job.state === 'running' || job.state === 'pending') {
      throw new HttpError(409, 'job-not-retryable', 'This job is already queued.');
    }
    return services.jobs.update(id, {
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  app.post('/api/jobs/:id/cancel', (request, reply) => {
    const { id } = request.params as { id: string };
    const job = services.jobs.find(id);
    if (job === null) {
      throw notFound('Job');
    }
    // Aborting the in-flight request is what actually stops the sidecar; the row is only
    // marked cancelled if the job had not started yet.
    const wasRunning = services.scheduler.cancel(id);
    if (!wasRunning) {
      services.jobs.update(id, { state: 'cancelled', finishedAt: new Date().toISOString() });
    }
    return reply.status(202).send({ cancelled: true, wasRunning });
  });
}
