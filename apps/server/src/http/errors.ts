// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppFastify } from './fastify-types';
import { ZodError } from 'zod';
import type { ApiError } from '@impressive-ocr/shared';
import { PathNotAllowedError } from '../infra/fs/safe-path';
import { PipelineValidationError } from '../modules/pipelines/pipeline-service';
import { SettingsValidationError } from '../modules/settings/settings-service';

/**
 * One place that turns a thrown error into an HTTP response.
 *
 * Two rules, both from CLAUDE.md §1: the client gets a stable code and a message safe to
 * display, and the *detail* — stack traces, absolute paths, internal identifiers — stays in
 * the server log. An unexpected error must never leak a filesystem path to a browser that
 * may be sitting on the other side of a LAN.
 */

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'not-found', `${what} not found`);

export function registerErrorHandler(app: AppFastify): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapError(error);

    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, 'Request failed');
    } else {
      request.log.debug({ err: error, url: request.url }, 'Request rejected');
    }

    const body: ApiError = {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
    };
    void reply.status(mapped.statusCode).send(body);
  });

  // The not-found handler is NOT registered here. Fastify allows exactly one per prefix, and
  // it has to know whether a built SPA is present so a browser deep link can fall back to
  // index.html while `/api/*` still answers with JSON. It is set once, in server.ts.
}

interface MappedError {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

/** Exported so the mapping can be tested without standing up a server. */
export function mapError(error: unknown): MappedError {
  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: 'validation-failed',
      message: 'The request body is not valid.',
      // Field paths and reasons are safe and genuinely useful; the raw input is not echoed.
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }

  if (error instanceof PipelineValidationError) {
    return {
      statusCode: 400,
      code: 'pipeline-invalid',
      message: error.message,
      details: { field: error.field },
    };
  }

  if (error instanceof SettingsValidationError) {
    return { statusCode: 400, code: 'settings-invalid', message: error.message };
  }

  if (error instanceof PathNotAllowedError) {
    // Deliberately terse: the response never repeats the path that was attempted, so a
    // probing client learns nothing about the filesystem layout.
    return {
      statusCode: 403,
      code: 'path-not-allowed',
      message: 'That folder is not authorised.',
    };
  }

  // Fastify's own errors already carry the right status — 415 for a media type it cannot
  // parse, 413 for an oversized body. Collapsing them all into 500 hid a real bug: a POST
  // with no body came back as "internal error" instead of something a client could act on.
  const fastify = asFastifyError(error);
  if (fastify !== null) {
    return {
      statusCode: fastify.statusCode,
      code: fastify.statusCode === 400 ? 'validation-failed' : 'bad-request',
      message: fastify.statusCode < 500 ? fastify.message : 'The request could not be handled.',
    };
  }

  return {
    statusCode: 500,
    code: 'internal-error',
    message: 'Something went wrong. Check the server log for details.',
  };
}

/** A Fastify error carrying a client-facing 4xx status. */
function asFastifyError(error: unknown): { statusCode: number; message: string } | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return null;
  }
  const candidate = error as { statusCode?: unknown; message?: unknown };
  if (typeof candidate.statusCode !== 'number' || candidate.statusCode >= 500) {
    return null;
  }
  return {
    statusCode: candidate.statusCode,
    message: typeof candidate.message === 'string' ? candidate.message : 'Bad request',
  };
}
