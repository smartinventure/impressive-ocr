// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseHandshake } from './sidecar-process';
import { parseMessage } from './sidecar-client';

describe('parseHandshake', () => {
  it('reads the port and protocol version', () => {
    expect(parseHandshake('{"event": "listening", "port": 60305, "protocolVersion": 1}')).toEqual(
      { port: 60305, protocolVersion: 1 },
    );
  });

  it('ignores unrelated stdout', () => {
    // A dependency printing a banner must not be mistaken for the handshake.
    expect(parseHandshake('Loading model weights...')).toBeNull();
  });

  it('ignores JSON that is not the listening event', () => {
    expect(parseHandshake('{"event": "error", "message": "boom"}')).toBeNull();
  });

  it('ignores a listening event with no port', () => {
    expect(parseHandshake('{"event": "listening"}')).toBeNull();
  });

  it('ignores malformed JSON rather than throwing', () => {
    expect(parseHandshake('{"event": "listening", ')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseHandshake('  {"event":"listening","port":1,"protocolVersion":1}  ')?.port).toBe(1);
  });
});

describe('parseMessage', () => {
  it('accepts a page progress message', () => {
    const message = parseMessage(
      '{"type":"page","jobId":"j1","page":3,"pageCount":10,"usedExistingTextLayer":false,"elapsedMs":812}',
    );

    expect(message).toMatchObject({ type: 'page', page: 3, pageCount: 10 });
  });

  it('accepts an error message and preserves the retry decision', () => {
    // The queue routes on this flag: retryable means backoff, otherwise quarantine.
    const message = parseMessage(
      '{"type":"error","jobId":"j1","code":"corrupt-document","message":"bad","retryable":false}',
    );

    expect(message).toMatchObject({ type: 'error', retryable: false });
  });

  it('defaults usedExistingTextLayer when the sidecar omits it', () => {
    const message = parseMessage(
      '{"type":"page","jobId":"j1","page":1,"pageCount":1,"elapsedMs":5}',
    );

    expect(message).toMatchObject({ usedExistingTextLayer: false });
  });

  it('rejects an unknown message type instead of passing it through', () => {
    expect(parseMessage('{"type":"surprise","jobId":"j1"}')).toBeNull();
  });

  it('rejects a message missing a required field', () => {
    expect(parseMessage('{"type":"done","jobId":"j1"}')).toBeNull();
  });

  it('returns null for a truncated line rather than throwing', () => {
    expect(parseMessage('{"type":"pa')).toBeNull();
  });
});
