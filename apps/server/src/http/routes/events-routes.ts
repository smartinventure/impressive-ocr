// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import type { ServerEvent } from '@impressive-ocr/shared';
import type { AppServices } from '../../app-services';

/**
 * Server-sent events: the live feed the UI subscribes to.
 *
 * SSE rather than WebSockets because the traffic is entirely one-way — the browser sends
 * commands over ordinary REST — and SSE reconnects by itself, which matters for a page left
 * open on a second monitor all day.
 */

/**
 * Proxies and browsers drop an idle connection after a minute or two, and a dead SSE stream
 * looks exactly like a stalled queue. A periodic heartbeat keeps it open and doubles as a
 * liveness signal the client can watch.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

export function registerEventRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer streaming responses by default, which would batch every
      // progress update into one delivery at the end of the job.
      'x-accel-buffering': 'no',
    });

    const send = (event: ServerEvent): void => {
      if (reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Tell the browser how long to wait before reconnecting, then send current state
    // immediately so a fresh tab paints without waiting for something to happen.
    reply.raw.write('retry: 3000\n\n');
    send({ type: 'heartbeat', at: new Date().toISOString() });

    const unsubscribe = services.events.subscribe(send);
    const heartbeat = setInterval(() => {
      send({ type: 'heartbeat', at: new Date().toISOString() });
    }, HEARTBEAT_INTERVAL_MS);

    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    // Both are needed: `close` covers a tab being closed, `aborted` covers the connection
    // dying. Leaking either would keep a listener attached for the life of the process.
    request.raw.on('close', close);
    request.raw.on('aborted', close);

    return reply;
  });
}
