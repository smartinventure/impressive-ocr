// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerUpdateStatus } from '@impressive-ocr/shared';
import type { AppServices } from '../../app-services';
import type { AppFastify } from '../fastify-types';

/**
 * Whether a newer release exists, and the request that asks the host to install it.
 *
 * Both sit under `/api/` and are therefore behind the authentication hook whenever a password
 * is configured — which matters for the second one: triggering an update recreates the
 * container, so it is a restart button, and an unauthenticated restart button on a service
 * bound to anything but loopback would be a denial-of-service primitive.
 */
export function registerUpdateRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/update/check', async (request): Promise<ServerUpdateStatus> => {
    // Fastify aborts this when the client disconnects, so a browser navigating away cancels
    // the outbound request instead of leaving it to time out.
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    return services.update.status(controller.signal);
  });

  app.post('/api/update/trigger', (_request, reply) => {
    const result = services.update.requestUpdate();
    if (result === null) {
      // No host updater is listening. A 409 rather than a 404: the endpoint exists and the
      // request was well formed, but this installation cannot act on it — the UI shows the
      // manual command for exactly this case.
      return reply.status(409).send({
        message:
          'No host updater is installed. Run the installer script, or update with `docker compose pull && docker compose up -d`.',
      });
    }
    return result;
  });
}
