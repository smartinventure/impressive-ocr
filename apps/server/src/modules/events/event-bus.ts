// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@impressive-ocr/shared';

/**
 * Fan-out of server events to every connected browser.
 *
 * Events are **advisory**. An SSE client that reconnects loses whatever was published while
 * it was away, so no screen may depend on having seen every event — each one also has a REST
 * endpoint returning full state. That constraint is what lets this stay a plain in-memory
 * emitter with no replay buffer or acknowledgements.
 */

const CHANNEL = 'server-event';

export type EventListener = (event: ServerEvent) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each browser tab is a listener, and a few dozen tabs is plausible on a shared server.
    // The default limit of 10 would log spurious leak warnings.
    this.emitter.setMaxListeners(200);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit(CHANNEL, event);
  }

  /** Subscribe, and get back the unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.emitter.on(CHANNEL, listener);
    return () => {
      this.emitter.off(CHANNEL, listener);
    };
  }

  get subscriberCount(): number {
    return this.emitter.listenerCount(CHANNEL);
  }
}

/** Convenience for publishers so every event carries a consistent timestamp. */
export function stamp<TEvent extends Omit<ServerEvent, 'at'>>(
  event: TEvent,
): TEvent & { at: string } {
  return { ...event, at: new Date().toISOString() };
}
