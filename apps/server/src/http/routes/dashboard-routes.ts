// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { AppServices } from '../../app-services';
import type { AppFastify } from '../fastify-types';

/**
 * The overview screen: what the machine is doing, and what has been done recently.
 *
 * One request rather than four. The dashboard polls, and four round trips per tick to render
 * one screen is the kind of thing that quietly becomes a performance problem on the very
 * machine the screen exists to report on.
 */
export function registerDashboardRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/dashboard', (request) => {
    const query = z
      .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
      .parse(request.query);

    const since = new Date(Date.now() - query.hours * 60 * 60 * 1000);
    const status = services.runtime.getStatus();

    return {
      windowHours: query.hours,
      resources: services.resources.sample(),
      hardware: services.runtime.getHardware(),
      runtime: { state: status.state, device: status.paddleFlavor },
      throughput: services.jobs.throughputSince(since),
      // Configured pipelines only; a Quick run's hidden pipeline is not something to list.
      pipelines: services.pipelines.list().map((pipeline) => ({
        id: pipeline.id,
        name: pipeline.name,
        enabled: pipeline.enabled,
        status: pipeline.status,
        inputPath: pipeline.options.source.inputPath,
        outputPath: pipeline.options.output.outputPath,
        formats: pipeline.options.output.formats,
        profile: pipeline.options.engine.profile,
        stats: pipeline.stats,
      })),
    };
  });
}
