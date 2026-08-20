// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { AppFastify } from '../fastify-types';
import type { AppServices } from '../../app-services';
import { HttpError } from '../errors';
import {
  browseFolders,
  createFolder,
  FolderBrowseError,
} from '../../modules/filesystem/folder-browser';

/**
 * Folder browsing for the pipeline editor and the settings allowlist.
 *
 * Two scopes, because there is a bootstrapping problem: pipeline folders must stay inside the
 * allowlist, but choosing what *goes into* the allowlist requires seeing the machine. So
 * `allowlist` scope is confined and open to the UI, while `system` scope is unconfined and
 * gated — it is a filesystem-disclosure primitive, and the template this was adapted from
 * says so in bold.
 */

const browseQuerySchema = z.object({
  path: z.string().max(4096).optional(),
  scope: z.enum(['allowlist', 'system']).default('allowlist'),
});

const createFolderSchema = z.object({
  path: z.string().min(1).max(4096),
  scope: z.enum(['allowlist', 'system']).default('allowlist'),
});

export function registerFilesystemRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/filesystem/browse', async (request) => {
    const query = browseQuerySchema.parse(request.query);
    assertScopeAllowed(query.scope, services);

    try {
      return await browseFolders({
        path: query.path ?? null,
        scope: query.scope,
        allowlist: services.settings.allowlist(),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post('/api/filesystem/create-folder', async (request, reply) => {
    const body = createFolderSchema.parse(request.body);
    assertScopeAllowed(body.scope, services);

    try {
      const path = await createFolder(body.path, {
        scope: body.scope,
        allowlist: services.settings.allowlist(),
      });
      return reply.status(201).send({ path });
    } catch (error) {
      throw toHttpError(error);
    }
  });
}

/**
 * Refuse unconfined browsing to anyone who is not sitting at this machine.
 *
 * Loopback means the request came from this computer, where the user already has a file
 * manager; over the network it would be a remote filesystem-disclosure endpoint, so there it
 * requires authentication to be switched on.
 */
function assertScopeAllowed(scope: 'allowlist' | 'system', services: AppServices): void {
  if (scope === 'allowlist') {
    return;
  }
  const settings = services.settings.get();
  if (settings.bindAddress === '127.0.0.1' || settings.authEnabled) {
    return;
  }
  throw new HttpError(
    403,
    'browse-scope-forbidden',
    'Browsing the whole filesystem is only available locally, or with authentication enabled.',
  );
}

function toHttpError(error: unknown): unknown {
  if (!(error instanceof FolderBrowseError)) {
    return error;
  }
  const status = error.code === 'permission-denied' || error.code === 'not-allowed' ? 403 : 404;
  return new HttpError(status, error.code, error.message);
}
