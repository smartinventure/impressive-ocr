// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from './fastify-types';
import type { Logger } from '../infra/logger';

/**
 * What to say about an HTTP request, which is usually nothing.
 *
 * Fastify's own logging writes two info lines per request. With the UI polling while a page
 * is open, an idle machine produced a couple of lines a second, and the events worth reading
 * -- a job that failed, a licence the server refused -- were gone from view within seconds.
 * A log people are asked to send with a bug report has to be mostly about the bug.
 *
 * So the rule is: a request that succeeded promptly says nothing at all. Everything else is
 * still there, and at a level that matches how much it matters.
 */

/** Above this, a request is worth a line even when it succeeded. */
const SLOW_REQUEST_MS = 2_000;

/**
 * Paths that are slow by design and would otherwise report themselves as a problem.
 *
 * The event stream is held open for the life of the page, and a Quick Mode upload is as slow
 * as the document is large.
 */
const EXPECTED_TO_BE_SLOW = ['/api/events', '/api/quick/upload'];

export function registerRequestLogging(app: AppFastify, logger: Logger): void {
  app.addHook('onResponse', (request, reply, done) => {
    const status = reply.statusCode;
    const elapsed = reply.elapsedTime;
    const details = {
      method: request.method,
      url: request.url,
      status,
      ms: Math.round(elapsed),
    };

    // A server fault is always worth a line: it is the thing someone will be looking for.
    if (status >= 500) {
      logger.error(details, 'Request failed');
      done();
      return;
    }

    // 4xx at debug, not warn. A 401 before login and a 404 from a probe are routine, and
    // warning about them trains people to ignore warnings.
    if (status >= 400) {
      logger.debug(details, 'Request rejected');
      done();
      return;
    }

    if (elapsed >= SLOW_REQUEST_MS && !EXPECTED_TO_BE_SLOW.some((p) => request.url.startsWith(p))) {
      logger.warn(details, 'Request was slow');
      done();
      return;
    }

    // The ordinary case: a request that worked, quickly. The detail is still available by
    // turning the level up, where it costs nothing because someone asked for it.
    logger.trace(details, 'Request completed');
    done();
  });
}
