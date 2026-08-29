// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import { createPipelineRequestSchema, updatePipelineRequestSchema } from '@impressive-ocr/shared';
import { notFound } from '../errors';
import type { AppServices } from '../../app-services';

/**
 * Pipeline CRUD.
 *
 * Routes stay thin on purpose: parse the input with a shared schema, call the service, map
 * the result. Every rule that matters — path authorisation, name uniqueness, the nested
 * input/output check — lives in the service, where it is testable without HTTP.
 */
export function registerPipelineRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/pipelines', () => services.pipelines.list());

  app.get('/api/pipelines/:id', (request) => {
    const { id } = request.params as { id: string };
    const pipeline = services.pipelines.get(id);
    if (pipeline === null) {
      throw notFound('Pipeline');
    }
    return pipeline;
  });

  app.post('/api/pipelines', async (request, reply) => {
    const body = createPipelineRequestSchema.parse(request.body);
    const created = await services.pipelines.create(body);
    await services.watchers.sync();
    return reply.status(201).send(created);
  });

  app.patch('/api/pipelines/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = updatePipelineRequestSchema.parse(request.body);
    const updated = await services.pipelines.update(id, body);
    if (updated === null) {
      throw notFound('Pipeline');
    }
    await services.watchers.sync();
    return updated;
  });

  app.delete('/api/pipelines/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Stop anything in flight before the row goes. `jobs.pipeline_id` cascades on delete, so
    // a running job's record disappears underneath the executor: the sidecar keeps working,
    // the writers still produce files, and every update lands on a row that no longer exists.
    // The UI only offers this on a paused pipeline, but pausing does not stop a document that
    // has already started, and a second tab or a script does not go through the UI at all.
    const cancelled = services.scheduler.cancelForPipeline(id);

    if (!services.pipelines.delete(id)) {
      throw notFound('Pipeline');
    }
    if (cancelled > 0) {
      request.log.info({ pipelineId: id, cancelled }, 'Cancelled in-flight jobs before deleting');
    }
    await services.watchers.sync();
    return reply.status(204).send();
  });

  // Pause/resume are separate endpoints rather than a PATCH on `enabled`: they are one-click
  // actions in the UI and should not require sending back a whole pipeline body.
  app.post('/api/pipelines/:id/pause', async (request) => {
    const { id } = request.params as { id: string };
    const updated = await services.pipelines.setEnabled(id, false);
    if (updated === null) {
      throw notFound('Pipeline');
    }
    return updated;
  });

  app.post('/api/pipelines/:id/resume', async (request) => {
    const { id } = request.params as { id: string };
    const updated = await services.pipelines.setEnabled(id, true);
    if (updated === null) {
      throw notFound('Pipeline');
    }
    return updated;
  });
}
