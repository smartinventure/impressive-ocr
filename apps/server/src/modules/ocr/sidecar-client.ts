// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SIDECAR_AUTH_HEADER,
  SIDECAR_PROTOCOL_VERSION,
  sidecarCapabilitiesResponseSchema,
  sidecarHealthResponseSchema,
  sidecarMessageSchema,
  type SidecarCapabilitiesResponse,
  type SidecarHealthResponse,
  type SidecarJobRequest,
  type SidecarMessage,
} from '@impressive-ocr/shared';

/**
 * HTTP client for one sidecar.
 *
 * Every message is validated against the shared schema before it reaches the queue. That is
 * not ceremony: the sidecar is a separate process on a different release cadence, and a
 * silently renamed field would otherwise show up as a job stuck at 0% rather than as an
 * error anyone can act on.
 */

export class SidecarProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarProtocolError';
  }
}

export interface SidecarClientOptions {
  port: number;
  authToken: string;
  host?: string | undefined;
}

export class SidecarClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(options: SidecarClientOptions) {
    this.baseUrl = `http://${options.host ?? '127.0.0.1'}:${options.port}`;
    this.authToken = options.authToken;
  }

  async health(signal?: AbortSignal): Promise<SidecarHealthResponse> {
    const response = await fetch(`${this.baseUrl}/health`, { signal: signal ?? null });
    if (!response.ok) {
      throw new SidecarProtocolError(`Health check failed with status ${response.status}`);
    }
    return sidecarHealthResponseSchema.parse(await response.json());
  }

  async capabilities(signal?: AbortSignal): Promise<SidecarCapabilitiesResponse> {
    const response = await fetch(`${this.baseUrl}/capabilities`, {
      headers: { [SIDECAR_AUTH_HEADER]: this.authToken },
      signal: signal ?? null,
    });
    if (!response.ok) {
      throw new SidecarProtocolError(`Capabilities failed with status ${response.status}`);
    }
    const capabilities = sidecarCapabilitiesResponseSchema.parse(await response.json());

    // A version mismatch means the two halves disagree about the wire format. Failing loudly
    // at startup beats a field quietly reading as undefined for every job afterwards.
    if (capabilities.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
      throw new SidecarProtocolError(
        `Sidecar speaks protocol ${capabilities.protocolVersion}, expected ${SIDECAR_PROTOCOL_VERSION}`,
      );
    }
    return capabilities;
  }

  /**
   * Submit a job and yield each NDJSON message as it arrives.
   *
   * An async generator so the caller stays in control: aborting the signal closes the
   * connection, and the sidecar sees the disconnect and abandons the document — which is how
   * a paused pipeline stops mid-file without a half-written output.
   */
  async *runJob(
    request: SidecarJobRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<SidecarMessage, void, undefined> {
    const response = await fetch(`${this.baseUrl}/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIDECAR_AUTH_HEADER]: this.authToken,
      },
      body: JSON.stringify(request),
      signal: signal ?? null,
    });

    if (!response.ok) {
      throw new SidecarProtocolError(
        `Job submission failed with status ${response.status}: ${await response.text()}`,
      );
    }
    if (response.body === null) {
      throw new SidecarProtocolError('Job response had no body');
    }

    for await (const line of readLines(response.body)) {
      const message = parseMessage(line);
      if (message !== null) {
        yield message;
      }
    }
  }
}

/**
 * Split a byte stream into complete lines.
 *
 * Network chunks fall mid-line, so parsing per chunk would corrupt every message that
 * straddles a boundary.
 */
async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) {
        yield line;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    yield buffer;
  }
}

/**
 * Validate one NDJSON line.
 *
 * Exported for testing. Returns null for an unparseable line rather than throwing: one bad
 * message should cost that message, not a document that is otherwise processing correctly.
 */
export function parseMessage(line: string): SidecarMessage | null {
  try {
    return sidecarMessageSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}
