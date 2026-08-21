// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { clearLogs, logSizes, MAX_TAIL_BYTES, readLogTail } from '../../infra/log-file';
import type { AppServices } from '../../app-services';
import type { AppFastify } from '../fastify-types';

/**
 * Read the application log back into the UI.
 *
 * A user whose documents keep quarantining has no other way to find out why: the desktop
 * build has no terminal, and the headless one writes into a service manager they may not be
 * able to reach. This is the difference between "it does not work" and a line number.
 *
 * Behind the auth hook like everything else under `/api` — the log names files the user
 * processed, which is exactly the PII the rest of the product is careful about.
 */
export function registerLogRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/logs', async (request) => {
    const query = z
      .object({ maxBytes: z.coerce.number().int().min(1024).max(MAX_TAIL_BYTES).optional() })
      .parse(request.query);

    const tail = await readLogTail(services.paths.logsDir, query.maxBytes ?? MAX_TAIL_BYTES);
    return { ...tail, files: await logSizes(services.paths.logsDir) };
  });

  app.delete('/api/logs', async () => {
    await clearLogs(services.paths.logsDir);
    return { ok: true };
  });
}
