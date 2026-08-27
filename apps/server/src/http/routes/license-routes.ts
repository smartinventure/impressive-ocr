// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  activateLicenseRequestSchema,
  releaseSeatRequestSchema,
  registerPersonalRequestSchema,
  type LicenseStatus,
} from '@impressive-ocr/shared';
import type { AppServices } from '../../app-services';
import type { Country } from '../../modules/license/license-client';
import { LicenseActivationError } from '../../modules/license/license-service';
import type { FastifyReply } from 'fastify';
import type { AppFastify } from '../fastify-types';

/**
 * Registration and entitlement.
 *
 * Thin, as every route here is: parse, call the service, map the one typed error onto a
 * status code. The distinction between a refused licence and an unreachable server lives in
 * the service and arrives here as `retryable`, because "your key is wrong" and "try again in
 * a minute" need different words in front of the user and different HTTP semantics behind it.
 */
export function registerLicenseRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/license', (): LicenseStatus => services.license.status());

  /**
   * The countries registration accepts, proxied rather than fetched by the browser.
   *
   * The page cannot call the licence server directly — a cross-origin request from a
   * `file://`-ish Electron origin or from localhost is not something that server permits —
   * and routing it through here also means one cache for every client rather than one per
   * open tab. `null` tells the client to use its bundled list.
   */
  app.get('/api/license/countries', async (): Promise<Country[] | null> => {
    return services.license.countries();
  });

  app.post('/api/license/personal', async (request, reply) => {
    const body = registerPersonalRequestSchema.parse(request.body ?? {});
    return withActivationErrors(reply, () => services.license.registerPersonal(body));
  });

  app.post('/api/license/activate', async (request, reply) => {
    const body = activateLicenseRequestSchema.parse(request.body ?? {});
    return withActivationErrors(reply, () => services.license.activate(body));
  });

  app.post('/api/license/release', async (request, reply) => {
    releaseSeatRequestSchema.parse(request.body ?? {});
    return withActivationErrors(reply, () => services.license.releaseSeat());
  });
}

async function withActivationErrors(
  reply: FastifyReply,
  call: () => Promise<LicenseStatus>,
): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof LicenseActivationError) {
      // 503 for something worth retrying, 402 for a licence the server declined — the one
      // status code that says "this is about payment or entitlement, not about your request".
      //
      // The licence server's own code is passed through rather than replaced. Flattening
      // everything to `license-not-activated` made `NO_SEATS_AVAILABLE` and
      // `VALIDATION_FAILED` indistinguishable on screen, and those need different actions
      // from the user and different answers from support.
      return reply.status(error.retryable ? 503 : 402).send({
        code: error.code ?? 'license-not-activated',
        message: error.message,
      });
    }
    throw error;
  }
}
