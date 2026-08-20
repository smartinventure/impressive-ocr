// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from '../infra/logger';

/**
 * The Fastify instance type this app actually uses.
 *
 * Passing a concrete pino instance as `loggerInstance` specializes Fastify's logger generic,
 * so a bare `FastifyInstance` no longer matches — every route registrar has to name the same
 * specialization. Declaring it once here keeps that out of each route file, and keeps the
 * alternative (casting the logger to `FastifyBaseLogger` to silence the compiler) off the
 * table.
 */
export type AppFastify = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
