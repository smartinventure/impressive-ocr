// SPDX-License-Identifier: AGPL-3.0-or-later
import { CSRF_HEADER, type ApiError } from '@impressive-ocr/shared';

/**
 * Thin fetch wrapper for the backend API.
 *
 * No axios: the whole surface is same-origin JSON, and `fetch` covers it. Every response is
 * funnelled through one place so a failure always arrives as an `ApiRequestError` carrying
 * the server's stable `code` — the UI branches on that, never on a message string.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The field a `pipeline-invalid` error points at, for highlighting the offending input. */
  get field(): string | null {
    const field = this.details?.field;
    return typeof field === 'string' ? field : null;
  }
}

/** Same origin: the SPA is served by the very backend it talks to, in both modes. */
const BASE = '/api';

/**
 * CSRF token for the current session, held in memory only.
 *
 * Not in localStorage: it would then outlive the session it belongs to and be readable by
 * every script on the origin for as long as the browser is installed. The auth store refills
 * it from `/api/auth/status` on boot, which is what makes a page refresh survivable.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Notified on any 401, so the app can drop to the login screen from anywhere. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal | undefined;
}

export async function request<TResult>(
  path: string,
  options: RequestOptions = {},
): Promise<TResult> {
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: buildHeaders(method, options.body !== undefined),
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
      // The server is local and unauthenticated by default; sending credentials would only
      // matter once auth exists, and same-origin is the correct scope for it then too.
      credentials: 'same-origin',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    // The backend runs in the same process as the window in desktop mode, so this almost
    // always means it is still starting or has stopped — worth saying rather than "failed
    // to fetch".
    throw new ApiRequestError(0, 'network-error', 'Cannot reach the Impressive OCR service.');
  }

  if (response.status === 204) {
    return undefined as TResult;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload ?? {}) as Partial<ApiError>;
    if (response.status === 401) {
      // The session expired or was revoked. Told once, centrally, so no individual caller
      // has to remember to handle it.
      onUnauthorized?.();
    }
    throw new ApiRequestError(
      response.status,
      error.code ?? 'unknown-error',
      error.message ?? `Request failed with status ${response.status}`,
      error.details,
    );
  }

  return payload as TResult;
}

function buildHeaders(method: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  // Only on mutating requests: the server does not ask for it on reads, and sending it
  // everywhere would leak it into more places than necessary.
  if (csrfToken !== null && MUTATING_METHODS.has(method)) headers[CSRF_HEADER] = csrfToken;
  return headers;
}

export const api = {
  get: <TResult>(path: string, signal?: AbortSignal): Promise<TResult> =>
    request<TResult>(path, { signal }),
  put: <TResult>(path: string, body: unknown): Promise<TResult> =>
    request<TResult>(path, { method: 'PUT', body }),
  post: <TResult>(path: string, body?: unknown): Promise<TResult> =>
    request<TResult>(path, { method: 'POST', body }),
  patch: <TResult>(path: string, body: unknown): Promise<TResult> =>
    request<TResult>(path, { method: 'PATCH', body }),
  delete: (path: string): Promise<void> => request<void>(path, { method: 'DELETE' }),
};
