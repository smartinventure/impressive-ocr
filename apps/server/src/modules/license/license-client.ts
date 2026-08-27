// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LicenseTier } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';

/**
 * The Speedbits License Manager, behind an interface.
 *
 * A seam rather than `fetch` calls inside the service, so everything that decides *what a
 * licence means* is testable without a network and the one part that talks to
 * license.speedbits.io is a single file.
 *
 * The flow is two steps, and both tiers converge on the second:
 *
 * 1. **Register** (`POST /api/register`) — personal only. Creates the account and emails a
 *    verification link; the licence key itself arrives by email *after* the link is clicked.
 *    A commercial customer already has a key from the purchase, so they skip this.
 * 2. **Validate** (`POST /api/installer/validate-license`) — both tiers. Takes the email and
 *    the key, claims a seat for this machine, and reports the two entitlement dates.
 *
 * That shape is worth stating because it is not the one you would guess: registering does
 * **not** return a key, so a personal user has to come back and enter the one they were
 * emailed. The screen has to say so, or it looks broken.
 */

/** Every response carries `success`; failures add `error`/`error_code` and a `message`. */
interface ServerResponse extends Record<string, unknown> {
  success?: boolean;
  message?: string;
  error?: string;
  error_code?: string;
}

export interface LicenseServerConfig {
  /**
   * Base URL of the licence service.
   *
   * **https, deliberately, although the API documentation gives the base URL as http.** Every
   * call here carries an email address, a licence key and a machine identifier; a licence key
   * is a bearer credential for the seats it holds. Over plain http all three are readable by
   * anything between the user and the server, on exactly the coffee-shop networks a desktop
   * app runs on. If the host genuinely does not serve TLS this has to be raised rather than
   * quietly downgraded, so the default stays https and only an explicit environment variable
   * can change it.
   */
  baseUrl: string;
  /**
   * The two products on the licence server, each with its own installer API key.
   *
   * One key per product, not one per application: the licence server issues them per product
   * and rejects a key used against the other with `INVALID_API_KEY`. Sending the commercial
   * key for a community registration would fail in a way that reads like a broken licence
   * rather than a wrong build flag.
   *
   * Neither key is a secret in this product, and it is worth being blunt about that: the
   * source is published, so anything compiled into it is public. They identify the *build*,
   * the server can revoke them, and they should be rotated per release.
   */
  personal: ProductCredentials;
  commercial: ProductCredentials;
  appVersion: string;
}

export interface ProductCredentials {
  /** `short_code` on the licence server, e.g. `impressiveocrcommunity`. */
  productCode: string;
  /** Installer API key for that product, e.g. `IMC_…`. */
  installerApiKey: string;
}

export interface RegisterRequest {
  email: string;
  /** ISO 3166-1 alpha-2. Required by the server, whatever its API reference says. */
  country: string;
  /**
   * The consents the licence server records.
   *
   * `acceptedLicense` is required too, and is also documented as optional — a registration
   * without it comes back `"accepted_license" is required`. All three are given together on
   * the first-run screen, which is what makes sending them honest rather than assumed.
   */
  acceptedTerms: boolean;
  acceptedPrivacy: boolean;
  acceptedLicense: boolean;
}

export interface ActivationRequest {
  tier: LicenseTier;
  email: string;
  licenseKey: string;
  /** 32 hex characters. Stable per installation, since it is what holds the seat. */
  machineId: string;
}

export interface ActivationResult {
  accepted: boolean;
  /** Seats left after this call, and the limit. `-1` from the server means unlimited. */
  seatsUsed: number | null;
  seatsAllowed: number | null;
  /** ISO date the licence stops working. Null for perpetual, which is the paid product. */
  licenseExpires: string | null;
  /** ISO date automatic updates end. The software keeps working past it. */
  updatesUntil: string | null;
  updateAccessExpired: boolean;
  /** Product name, for display. */
  tierName: string | null;
  message: string | null;
}

export interface ReleaseRequest {
  tier: LicenseTier;
  email: string;
  licenseKey: string;
  machineId: string;
}

export interface ReleaseResult {
  /**
   * False when this machine held no seat — not an error.
   *
   * The endpoint is idempotent by design, so an uninstaller that runs twice, or one that runs
   * after the customer already cleared the seat from the portal, gets a 200 rather than a
   * failure reported to someone who is removing the software anyway.
   */
  released: boolean;
  seatsUsed: number | null;
  seatsAllowed: number | null;
}

export interface UpdateEligibility {
  updateAvailable: boolean;
  latestVersion: string | null;
  updatesUntil: string | null;
  /** True once the update window closed. Auto-updates stop; nothing else changes. */
  updateAccessExpired: boolean;
}

export interface LicenseClient {
  /** Personal tier only. The key arrives by email once the address is verified. */
  register(request: RegisterRequest, signal?: AbortSignal): Promise<void>;
  activate(request: ActivationRequest, signal?: AbortSignal): Promise<ActivationResult>;
  /** Hand this machine's seat back so another can take it. */
  releaseSeat(request: ReleaseRequest, signal?: AbortSignal): Promise<ReleaseResult>;
  checkUpdate(
    licenseKey: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<UpdateEligibility>;
}

export class LicenseServerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The server's own code — `NO_SEATS_AVAILABLE`, `LICENSE_EXPIRED` — for logs. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'LicenseServerError';
  }
}

/** Long enough for a slow link, short enough that a hung server is not a hung first run. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Codes that mean "the licence is fine, the moment is wrong" — worth another try — as opposed
 * to a decision about the licence that retrying cannot change.
 */
const RETRYABLE_CODES = new Set(['SERVER_ERROR']);

export class HttpLicenseClient implements LicenseClient {
  constructor(
    private readonly config: LicenseServerConfig,
    private readonly logger: Logger,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async register(request: RegisterRequest, signal?: AbortSignal): Promise<void> {
    await this.post(
      '/api/register',
      {
        email: request.email,
        country: request.country,
        short_code: this.config.personal.productCode,
        accepted_terms: request.acceptedTerms,
        accepted_privacy: request.acceptedPrivacy,
        accepted_license: request.acceptedLicense,
        // Explicitly declined. There is no telemetry in this product and adding an analytics
        // opt-in on someone's behalf would contradict that promise.
        accepted_matomo: false,
      },
      signal,
    );
  }

  /** Which product a tier maps to. The two differ in code *and* in API key. */
  private credentials(tier: LicenseTier): ProductCredentials {
    return tier === 'personal' ? this.config.personal : this.config.commercial;
  }

  async activate(request: ActivationRequest, signal?: AbortSignal): Promise<ActivationResult> {
    const product = this.credentials(request.tier);

    const payload = await this.post(
      '/api/installer/validate-license',
      {
        email: request.email,
        license_key: request.licenseKey,
        machine_id: request.machineId,
        version: this.config.appVersion,
        api_key: product.installerApiKey,
        // Guards against activating a commercial key against the free product, and the other
        // way round — which would otherwise succeed and silently record the wrong tier.
        product_edition: product.productCode,
      },
      signal,
    );

    const seatsTotal = asNumber(payload.seats_total);
    const seatsRemaining = asNumber(payload.seats_remaining);

    return {
      accepted: payload.valid === true || payload.success === true,
      // The server reports what is *left*; the screen wants what is *used*. `-1` is its
      // spelling of unlimited, which is not a number of seats and must not be shown as one.
      seatsAllowed: seatsTotal === null || seatsTotal < 0 ? null : seatsTotal,
      seatsUsed:
        seatsTotal === null || seatsTotal < 0 || seatsRemaining === null
          ? null
          : seatsTotal - seatsRemaining,
      licenseExpires: asString(payload.license_expires),
      updatesUntil: asString(payload.update_eligible_until),
      updateAccessExpired: payload.update_access_expired === true,
      tierName: asString(payload.tier_name),
      message: asString(payload.message),
    };
  }

  /**
   * Release this machine's seat.
   *
   * Takes the same four credentials as activation, so an uninstaller can reuse what it
   * already has. It works on expired and revoked licences too — refusing there would strand
   * the seat on exactly the licences someone is most likely to be uninstalling — and it does
   * not consume one of the licence's transfers.
   */
  async releaseSeat(request: ReleaseRequest, signal?: AbortSignal): Promise<ReleaseResult> {
    const product = this.credentials(request.tier);

    const payload = await this.post(
      '/api/installer/release-seat',
      {
        email: request.email,
        license_key: request.licenseKey,
        machine_id: request.machineId,
        api_key: product.installerApiKey,
      },
      signal,
    );

    const seatsTotal = asNumber(payload.seats_total);
    const seatsRemaining = asNumber(payload.seats_remaining);

    return {
      released: payload.released === true,
      seatsAllowed: seatsTotal === null || seatsTotal < 0 ? null : seatsTotal,
      seatsUsed:
        seatsTotal === null || seatsTotal < 0 || seatsRemaining === null
          ? null
          : seatsTotal - seatsRemaining,
    };
  }

  async checkUpdate(
    licenseKey: string,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<UpdateEligibility> {
    const payload = await this.post(
      '/api/installer/check-update',
      {
        license_key: licenseKey,
        machine_id: machineId,
        current_version: this.config.appVersion,
      },
      signal,
    );

    return {
      updateAvailable: payload.update_available === true,
      latestVersion: asString(payload.latest_version),
      updatesUntil: asString(payload.update_eligible_until),
      updateAccessExpired: payload.update_access_expired === true,
    };
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ServerResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': `ImpressiveOCR/${this.config.appVersion}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      // No network, DNS failure, timeout. Says nothing about the licence.
      this.logger.warn({ err: error, path }, 'Could not reach the licence server');
      throw new LicenseServerError('The licence server could not be reached.', true);
    }

    const payload = await readJson(response);
    const code = asString(payload.error_code) ?? asString(payload.error);

    if (response.status >= 500) {
      throw new LicenseServerError(
        'The licence server is temporarily unavailable. Please try again.',
        true,
        code,
      );
    }

    if (response.status >= 400 || payload.success === false) {
      // The server writes wording meant for the user, so it is shown rather than replaced.
      // Only its absence falls back to something generic.
      const message = asString(payload.message) ?? describe(code);
      throw new LicenseServerError(message, code !== null && RETRYABLE_CODES.has(code), code);
    }

    return payload;
  }
}

/**
 * Wording for the server's codes, used only when it sends no message of its own.
 *
 * Every one of these is something the user can act on, which is the test for whether it
 * belongs here: "no seats left" tells them to free a machine, `VALIDATION_FAILED` tells them
 * to check what they typed. The server returns that same generic code for every ownership
 * failure on purpose, so the endpoint cannot be used to find out which addresses exist —
 * which means this wording must not guess at a more specific reason either.
 */
function describe(code: string | null): string {
  switch (code) {
    case 'NO_SEATS_AVAILABLE':
      return 'This licence is already in use on the maximum number of machines.';
    case 'LICENSE_EXPIRED':
      return 'This licence has expired.';
    case 'LICENSE_INACTIVE':
      return 'This licence is not active. Please contact support.';
    case 'EDITION_MISMATCH':
      return 'That key belongs to a different product.';
    case 'INVALID_MACHINE_ID':
      return 'This machine could not be identified. Please report this.';
    case 'INVALID_API_KEY':
      return 'This version of Impressive OCR can no longer activate. Please update.';
    case 'VALIDATION_FAILED':
      return 'That email address and licence key do not match.';
    default:
      return 'The licence could not be verified.';
  }
}

async function readJson(response: Response): Promise<ServerResponse> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as ServerResponse) : {};
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
