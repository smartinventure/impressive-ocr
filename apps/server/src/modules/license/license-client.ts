// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LicenseTier } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';

/**
 * The licence server, behind an interface.
 *
 * A `Protocol`-shaped seam rather than `fetch` calls inside the service, for the ordinary
 * reason: everything that decides *what a licence means* is testable without a network, and
 * the one part that talks to license.speedbits.io is a single file that can be rewritten when
 * the real endpoint shapes arrive without touching a line of the logic above it.
 *
 * **The HTTP implementation below is written against an assumed contract and is not yet
 * confirmed against the real service.** The request and response shapes are documented here
 * so they can be checked against the API rather than reverse-engineered from the code.
 */

export interface ActivationRequest {
  tier: LicenseTier;
  email: string;
  /** Absent for a personal registration, which has no key. */
  licenseKey?: string | undefined;
  /** Salted hash of the OS machine identifier. Never the raw value. */
  machineId: string;
  /** So the server can tell a desktop seat from a headless one, and report versions. */
  appVersion: string;
  platform: string;
}

export interface ActivationResult {
  /** False when the server refused: unknown key, seat limit reached, licence revoked. */
  accepted: boolean;
  /**
   * True when a confirmation email has been sent and the registration is not complete until
   * the user clicks it. Personal registrations only.
   */
  requiresEmailConfirmation: boolean;
  /** When automatic updates stop. The licence itself never expires. */
  updatesUntil: string | null;
  seatsUsed: number | null;
  seatsAllowed: number | null;
  /** Shown to the user verbatim when present, so the server owns its own refusal wording. */
  message: string | null;
}

export interface ReleaseRequest {
  email: string;
  licenseKey?: string | undefined;
  machineId: string;
}

export interface LicenseClient {
  activate(request: ActivationRequest, signal?: AbortSignal): Promise<ActivationResult>;
  /** Hand a seat back so another machine can take it. */
  release(request: ReleaseRequest, signal?: AbortSignal): Promise<void>;
}

export class LicenseServerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LicenseServerError';
  }
}

export interface HttpLicenseClientOptions {
  /** Base URL of the licence service, without a trailing slash. */
  baseUrl: string;
  appVersion: string;
  logger: Logger;
  timeoutMs?: number;
}

/** Long enough for a slow link, short enough that a hung server is not a hung first run. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Talks to license.speedbits.io.
 *
 * Assumed contract, pending confirmation:
 *
 * ```
 * POST {baseUrl}/v1/activations
 *   → { accepted, requiresEmailConfirmation, updatesUntil, seatsUsed, seatsAllowed, message }
 * POST {baseUrl}/v1/activations/release
 *   → 204
 * ```
 *
 * A refusal is expected to arrive as `200` with `accepted: false` and a `message`, because a
 * rejected key is a normal answer rather than a transport failure — and the two need
 * different handling. A `4xx` is treated as a permanent refusal, a `5xx` or a timeout as
 * retryable, so the caller can tell "your key is wrong" from "try again in a minute".
 */
export class HttpLicenseClient implements LicenseClient {
  constructor(private readonly options: HttpLicenseClientOptions) {}

  async activate(request: ActivationRequest, signal?: AbortSignal): Promise<ActivationResult> {
    const payload = await this.post('/v1/activations', request, signal);
    return {
      accepted: payload.accepted === true,
      requiresEmailConfirmation: payload.requiresEmailConfirmation === true,
      updatesUntil: asString(payload.updatesUntil),
      seatsUsed: asNumber(payload.seatsUsed),
      seatsAllowed: asNumber(payload.seatsAllowed),
      message: asString(payload.message),
    };
  }

  async release(request: ReleaseRequest, signal?: AbortSignal): Promise<void> {
    await this.post('/v1/activations/release', request, signal);
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `ImpressiveOCR/${this.options.appVersion}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      // No network, DNS failure, timeout. Always worth another try later.
      this.options.logger.warn({ err: error, path }, 'Could not reach the licence server');
      throw new LicenseServerError('The licence server could not be reached.', true);
    }

    if (response.status >= 500) {
      // Retryable: the server is broken or restarting, which says nothing about the licence.
      throw new LicenseServerError('The licence server is temporarily unavailable.', true);
    }

    const payload = await readJson(response);
    if (response.status >= 400) {
      const message = asString(payload.message) ?? `The licence server refused the request.`;
      throw new LicenseServerError(message, false);
    }
    return payload;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A licence server answering with HTML is a misconfiguration, not a licence decision.
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
