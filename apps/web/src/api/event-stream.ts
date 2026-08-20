// SPDX-License-Identifier: AGPL-3.0-or-later
import { serverEventSchema, type ServerEvent } from '@impressive-ocr/shared';

/**
 * The live feed from the server.
 *
 * Events are advisory: `EventSource` reconnects on its own but replays nothing, so anything
 * published while the connection was down is simply lost. Every screen therefore also loads
 * its state over REST, and treats events purely as an accelerator. Designing it the other way
 * — trusting the stream — is how a queue UI ends up showing a progress bar frozen at 40%.
 */

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export interface EventStreamHandlers {
  onEvent: (event: ServerEvent) => void;
  onStateChange?: (state: ConnectionState) => void;
  /**
   * Called when the stream reconnects after a drop, so the caller can refetch and close the
   * gap left by the events it missed.
   */
  onResync?: () => void;
}

export interface EventStreamHandle {
  close: () => void;
}

export function connectEventStream(handlers: EventStreamHandlers): EventStreamHandle {
  let source: EventSource | null = null;
  let closed = false;
  let hasConnectedBefore = false;

  const setState = (state: ConnectionState): void => handlers.onStateChange?.(state);

  const open = (): void => {
    if (closed) {
      return;
    }
    setState(hasConnectedBefore ? 'reconnecting' : 'connecting');

    source = new EventSource('/api/events');

    source.onopen = () => {
      setState('open');
      if (hasConnectedBefore) {
        // Second and later opens mean we were disconnected and missed events.
        handlers.onResync?.();
      }
      hasConnectedBefore = true;
    };

    source.onmessage = (message: MessageEvent<string>) => {
      const event = parseEvent(message.data);
      if (event !== null) {
        handlers.onEvent(event);
      }
    };

    source.onerror = () => {
      // EventSource reconnects by itself using the server's `retry:` hint; reporting the
      // state is all that is needed, and closing here would defeat that.
      setState('reconnecting');
    };
  };

  // The server names each event, so a named listener is needed alongside onmessage — which
  // only fires for events with no `event:` field.
  const attachNamedListeners = (): void => {
    if (source === null) {
      return;
    }
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        const event = parseEvent((message as MessageEvent<string>).data);
        if (event !== null) {
          handlers.onEvent(event);
        }
      });
    }
  };

  open();
  attachNamedListeners();

  return {
    close: () => {
      closed = true;
      source?.close();
      source = null;
    },
  };
}

const EVENT_TYPES = [
  'pipeline.upserted',
  'pipeline.deleted',
  'pipeline.status',
  'job.upserted',
  'job.progress',
  'job.event',
  'runtime.status',
  'system.status',
  'heartbeat',
] as const;

/**
 * Validate an incoming frame against the shared schema.
 *
 * A malformed or unknown event is dropped rather than thrown: one bad frame must not take
 * down a stream the whole UI depends on, and the REST fallback will correct the state anyway.
 */
export function parseEvent(data: string): ServerEvent | null {
  try {
    return serverEventSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}
