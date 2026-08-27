// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  activateLicenseRequestSchema,
  forgetLicenseRequestSchema,
  registerPersonalRequestSchema,
  type LicenseStatus,
} from '@impressive-ocr/shared';
import type { AppServices } from '../../app-services';
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

  app.post('/api/license/personal', async (request, reply) => {
    const body = registerPersonalRequestSchema.parse(request.body ?? {});
    return withActivationErrors(reply, () => services.license.registerPersonal(body));
  });

  app.post('/api/license/activate', async (request, reply) => {
    const body = activateLicenseRequestSchema.parse(request.body ?? {});
    return withActivationErrors(reply, () => services.license.activate(body));
  });

  /** Local only: the licence server has no endpoint for handing a seat back. */
  app.post('/api/license/forget', (request): LicenseStatus => {
    forgetLicenseRequestSchema.parse(request.body ?? {});
    return services.license.forget();
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
      return reply
        .status(error.retryable ? 503 : 402)
        .send({ code: 'license-not-activated', message: error.message });
    }
    throw error;
  }
}
