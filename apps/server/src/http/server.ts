// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import {
  QUICK_UPLOAD_MAX_FILES,
  QUICK_UPLOAD_MAX_FILE_BYTES,
  type ApiError,
  type AppSettings,
} from '@impressive-ocr/shared';
import type { Logger } from '../infra/logger';
import type { AppServices } from '../app-services';
import { HttpError, registerErrorHandler } from './errors';
import type { AppFastify } from './fastify-types';
import { registerAuthHook } from './auth-hook';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerConsentRoutes } from './routes/consent-routes';
import { registerEventRoutes } from './routes/events-routes';
import { registerFilesystemRoutes } from './routes/filesystem-routes';
import { registerJobRoutes } from './routes/jobs-routes';
import { registerPipelineRoutes } from './routes/pipelines-routes';
import { registerDashboardRoutes } from './routes/dashboard-routes';
import { registerLogRoutes } from './routes/logs-routes';
import { registerQuickRoutes } from './routes/quick-routes';
import { registerSystemRoutes } from './routes/system-routes';

export interface HttpServerOptions {
  services: AppServices;
  settings: AppSettings;
  logger: Logger;
  /** Directory holding the built Vue SPA. Omitted in dev, where Vite serves it. */
  webRoot?: string | undefined;
  /** Certificate and key, when the UI is served over https. */
  tls?: { certificate: string; key: string } | undefined;
}

export async function createHttpServer(options: HttpServerOptions): Promise<AppFastify> {
  const app = Fastify({
    loggerInstance: options.logger,
    // Fastify decides http vs https at construction from the presence of `https`, so the
    // material has to be resolved before this point rather than at listen() time.
    ...(options.tls === undefined
      ? {}
      : { https: { cert: options.tls.certificate, key: options.tls.key } }),
    // The app is reached by its own users on their own machine; there is no reverse proxy
    // whose forwarded headers we should believe.
    trustProxy: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Registered before helmet and the routes so `request.cookies` exists in the auth hook.
  await app.register(fastifyCookie);

  // Quick Mode uploads. The ceiling is per file and enforced by the plugin, so an oversized
  // upload is cut off as it streams rather than after it has filled the disk.
  await app.register(fastifyMultipart, {
    limits: { fileSize: QUICK_UPLOAD_MAX_FILE_BYTES, files: QUICK_UPLOAD_MAX_FILES },
  });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vuetify injects component styles at runtime, so inline styles cannot be
        // eliminated. Scripts stay strict — that is where the real risk is.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        // A local-first app has no business talking to anything but itself.
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    // Off for http on loopback, where it would poison the browser's cache for localhost
    // across every other local development server. On once we genuinely serve https, where
    // it is what stops a downgrade back to cleartext.
    hsts: options.tls !== undefined,
    crossOriginEmbedderPolicy: false,
  });

  /**
   * Accept a body-less POST, whatever content type the client happened to send.
   *
   * Several endpoints are pure commands — pause, resume, retry, install — and clients send
   * them with no body at all. Fastify refuses those two different ways: 415 when the
   * `Content-Type` has no registered parser, and 400 from the built-in JSON parser when the
   * payload is empty. Both had to be handled; between them they were breaking the pause
   * button with an "internal error".
   *
   * An empty payload carries nothing to mis-parse, so accepting it is safe. A *non-empty*
   * body of an unregistered type is still rejected.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        done(new HttpError(400, 'invalid-json', 'The request body is not valid JSON.'), undefined);
      }
    },
  );

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body: Buffer, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    done(new HttpError(415, 'unsupported-media-type', 'Send the request body as JSON.'), undefined);
  });

  registerErrorHandler(app);

  // Before the routes: the hook has to see every API request, including ones added later.
  registerAuthHook(app, { auth: options.services.auth, settings: options.services.settings });

  registerAuthRoutes(app, options.services);
  registerConsentRoutes(app, options.services);

  registerPipelineRoutes(app, options.services);
  registerQuickRoutes(app, options.services);
  registerLogRoutes(app, options.services);
  registerDashboardRoutes(app, options.services);
  registerJobRoutes(app, options.services);
  registerSystemRoutes(app, options.services);
  registerFilesystemRoutes(app, options.services);
  registerEventRoutes(app, options.services);

  app.get('/api/health', () => ({ status: 'ok' }));

  await registerWebUi(app, options);

  return app;
}

/**
 * Serve the built SPA, and install the single not-found handler.
 *
 * Fastify permits exactly one not-found handler per prefix, so this is the only place one is
 * registered. It has to serve two audiences at once: `/api/*` must answer with the same JSON
 * error shape as everything else, while any other path returns index.html so a deep link
 * like `/pipelines/abc` survives a browser refresh instead of 404-ing.
 */
async function registerWebUi(app: AppFastify, options: HttpServerOptions): Promise<void> {
  const webRoot = options.webRoot;
  const hasSpa = webRoot !== undefined && existsSync(join(webRoot, 'index.html'));

  if (hasSpa) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  } else {
    options.logger.info('No built web UI found; run the Vite dev server for the interface');
  }

  app.setNotFoundHandler((request, reply) => {
    const wantsSpa = hasSpa && !request.url.startsWith('/api/');
    if (wantsSpa) {
      return reply.sendFile('index.html');
    }
    const body: ApiError = { code: 'not-found', message: 'Endpoint not found' };
    return reply.status(404).send(body);
  });
}
