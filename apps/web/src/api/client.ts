// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ApiError } from '@impressive-ocr/shared';

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

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
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
    throw new ApiRequestError(
      response.status,
      error.code ?? 'unknown-error',
      error.message ?? `Request failed with status ${response.status}`,
      error.details,
    );
  }

  return payload as TResult;
}

export const api = {
  get: <TResult>(path: string, signal?: AbortSignal): Promise<TResult> =>
    request<TResult>(path, { signal }),
  post: <TResult>(path: string, body?: unknown): Promise<TResult> =>
    request<TResult>(path, { method: 'POST', body }),
  patch: <TResult>(path: string, body: unknown): Promise<TResult> =>
    request<TResult>(path, { method: 'PATCH', body }),
  delete: (path: string): Promise<void> => request<void>(path, { method: 'DELETE' }),
};
