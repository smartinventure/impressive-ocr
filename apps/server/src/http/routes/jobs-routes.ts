// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import { z } from 'zod';
import { jobStateSchema, paginationQuerySchema } from '@impressive-ocr/shared';
import { HttpError, notFound } from '../errors';
import type { AppServices } from '../../app-services';

const jobListQuerySchema = paginationQuerySchema.extend({
  pipelineId: z.string().min(1).optional(),
  state: jobStateSchema.optional(),
});

export function registerJobRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/jobs', (request) => {
    const query = jobListQuerySchema.parse(request.query);
    const { items, total } = services.jobs.list({
      pipelineId: query.pipelineId,
      state: query.state,
      limit: query.limit,
      offset: query.offset,
    });
    return { items, total, limit: query.limit, offset: query.offset };
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
