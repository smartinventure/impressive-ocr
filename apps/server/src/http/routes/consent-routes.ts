// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppFastify } from '../fastify-types';
import { acceptConsentRequestSchema, type ConsentStatus } from '@impressive-ocr/shared';
import { ConsentVersionMismatchError } from '../../modules/consent/consent-service';
import type { AppServices } from '../../app-services';

/**
 * Whether the user has agreed to the terms, the privacy policy and the licence — and the
 * endpoint that records it.
 */
export function registerConsentRoutes(app: AppFastify, services: AppServices): void {
  app.get('/api/consent', (): ConsentStatus => services.consent.status());

  app.post('/api/consent/accept', (request, reply) => {
    const body = acceptConsentRequestSchema.parse(request.body ?? {});
    try {
      return services.consent.accept(body.version);
    } catch (error) {
      if (error instanceof ConsentVersionMismatchError) {
        // The screen the user agreed to is not the one this build requires — an app left
        // open across an update. Ask again rather than recording the wrong agreement.
        return reply.status(409).send({
          message: 'These terms have been superseded. Reload and read them again.',
        });
      }
      throw error;
    }
  });
}
