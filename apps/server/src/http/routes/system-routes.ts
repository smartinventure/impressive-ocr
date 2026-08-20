// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import { z } from 'zod';
import {
  APP_VERSION,
  updateSettingsRequestSchema,
  type SystemStatus,
} from '@impressive-ocr/shared';
import { describeGpuReason } from '../../modules/runtime/gpu-probe';
import type { AppServices } from '../../app-services';

export function registerSystemRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/system/status', (): SystemStatus => {
    const hardware = services.runtime.getHardware();
    return {
      appVersion: APP_VERSION,
      hardware,
      runtime: services.runtime.getStatus(),
      sidecars: services.pool.health(),
      globallyPaused: services.isGloballyPaused(),
      uptimeSeconds: process.uptime(),
    };
  });

  /**
   * The hardware summary the setup wizard and the system screen render.
   *
   * The explanation is built server-side so the same wording appears everywhere and the UI
   * never has to translate a reason code into prose.
   */
  app.get('/api/system/hardware', () => {
    const hardware = services.runtime.getHardware();
    return {
      ...hardware,
      explanation:
        hardware.gpuUnavailableReason === null
          ? null
          : describeGpuReason(hardware.gpuUnavailableReason, hardware.gpu),
    };
  });

  app.post('/api/system/hardware/probe', async () => services.runtime.probe());

  app.get('/api/system/runtime', () => services.runtime.getStatus());

  app.post('/api/system/runtime/install', (_request, reply) => {
    // Fire and forget: the install runs for minutes and reports through SSE, so holding the
    // request open would just give the browser a timeout to deal with.
    void services.runtime.startInstall();
    return reply.status(202).send(services.runtime.getStatus());
  });

  app.post('/api/system/runtime/cancel', () => ({
    cancelled: services.runtime.cancelInstall(),
  }));

  app.post('/api/system/pause', () => {
    services.setGloballyPaused(true);
    return { globallyPaused: true };
  });

  app.post('/api/system/resume', () => {
    services.setGloballyPaused(false);
    return { globallyPaused: false };
  });

  app.get('/api/settings', () => services.settings.get());

  app.patch('/api/settings', (request) => {
    const body = updateSettingsRequestSchema.parse(request.body);
    return services.settings.update(body);
  });

  /**
   * Validate a folder path without creating anything.
   *
   * The pipeline editor calls this as the user types, so a bad path is caught inline rather
   * than on save. It is also what makes the browser-served (headless) mode usable, where
   * there is no native folder picker.
   */
  app.post('/api/settings/validate-folder', async (request) => {
    const body = z
      .object({ path: z.string().min(1), mustExist: z.boolean().default(true) })
      .parse(request.body);

    try {
      const resolved = await services.resolveFolder(body.path, body.mustExist);
      return { valid: true, resolvedPath: resolved, message: null };
    } catch (error) {
      return {
        valid: false,
        resolvedPath: null,
        message: error instanceof Error ? error.message : 'That folder is not authorised.',
      };
    }
  });
}
