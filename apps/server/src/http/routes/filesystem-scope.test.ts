// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { BindAddress } from '@impressive-ocr/shared';
import type { AppFastify } from '../fastify-types';
import type { AppServices } from '../../app-services';
import { registerErrorHandler } from '../errors';
import { registerFilesystemRoutes } from './filesystem-routes';

/**
 * Who may browse the whole filesystem.
 *
 * `system` scope is a filesystem-disclosure primitive, allowed only to someone sitting at the
 * machine or behind authentication. It decided that from the *stored* bind address — and a
 * container sets `IMPRESSIVE_OCR_BIND_ADDRESS=0.0.0.0`, which is merged into the settings the
 * HTTP layer receives but never written to the store. So the store still read `127.0.0.1`,
 * the guard concluded "loopback, allow", and every containerised install exposed its whole
 * filesystem to anyone who could reach the port. With `/:/host:ro` that is the host's.
 */

function servicesWith(authEnabled: boolean): AppServices {
  return {
    settings: {
      get: () => ({ authEnabled }),
      allowlist: () => [],
      authorizeFolder: vi.fn(),
    },
  } as unknown as AppServices;
}

async function browseSystemScope(boundAddress: BindAddress, authEnabled = false) {
  const app = Fastify() as unknown as AppFastify;
  registerErrorHandler(app);
  registerFilesystemRoutes(app, servicesWith(authEnabled), boundAddress);

  const response = await app.inject({ method: 'GET', url: '/api/filesystem/browse?scope=system' });
  await app.close();
  return response;
}

describe('unconfined browsing', () => {
  it('is refused when the server is bound to every interface without authentication', async () => {
    // The container default, and the case that was open.
    const response = await browseSystemScope('0.0.0.0');

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('browse-scope-forbidden');
  });

  it('is allowed on loopback, where the user already has a file manager', async () => {
    const response = await browseSystemScope('127.0.0.1');

    expect(response.statusCode).not.toBe(403);
  });

  it('is allowed on every interface once authentication is on', async () => {
    // Then the auth hook is what stands in front of it, which is the intended arrangement.
    const response = await browseSystemScope('0.0.0.0', true);

    expect(response.statusCode).not.toBe(403);
  });

  it('never blocks the confined scope, whatever the binding', async () => {
    // The pipeline editor uses this on every install; it cannot depend on the address.
    const app = Fastify() as unknown as AppFastify;
    registerErrorHandler(app);
    registerFilesystemRoutes(app, servicesWith(false), '0.0.0.0');

    const response = await app.inject({ method: 'GET', url: '/api/filesystem/browse' });
    await app.close();

    expect(response.statusCode).not.toBe(403);
  });
});
