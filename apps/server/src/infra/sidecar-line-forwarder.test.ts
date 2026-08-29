// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { createSidecarLineForwarder, type Logger } from './logger';

/**
 * What reaches the log from a sidecar's own console.
 *
 * The behaviour this pins down: of 916 lines written to one installation's log in a day, 759
 * were PaddleOCR narrating which model it was building. They arrived unparsed, were logged at
 * info, and buried the events someone would actually search for.
 *
 * The hard part is that a Python traceback arrives on the same stream, also unparsed, and has
 * to stay readable — including the `ExceptionType: message` line at the end, which is the part
 * that says what went wrong.
 */

function recorder() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger: logger as unknown as Logger, calls: logger };
}

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "engine.py", line 40, in run',
  '    raise ValueError("bad page")',
  'ValueError: bad page',
];

describe('createSidecarLineForwarder', () => {
  it('keeps a structured line at the level it declared', () => {
    const { logger, calls } = recorder();

    createSidecarLineForwarder(logger)(JSON.stringify({ level: 'error', msg: 'Engine failed' }));

    expect(calls.error).toHaveBeenCalledWith(expect.anything(), 'Engine failed');
  });

  it('drops third-party chatter to debug', () => {
    // The 759 lines. Still available by raising the level, no longer the log.
    const { logger, calls } = recorder();

    createSidecarLineForwarder(logger)("Creating model: ('PP-OCRv6_medium_det', None, None)");

    expect(calls.debug).toHaveBeenCalled();
    expect(calls.info).not.toHaveBeenCalled();
  });

  it('keeps every line of a traceback at warn, including the exception', () => {
    const { logger, calls } = recorder();
    const forward = createSidecarLineForwarder(logger);

    for (const line of TRACEBACK) forward(line);

    expect(calls.warn).toHaveBeenCalledTimes(TRACEBACK.length);
    expect(calls.debug).not.toHaveBeenCalled();
    const messages = calls.warn.mock.calls.map((call) => call[0]);
    expect(JSON.stringify(messages)).toContain('ValueError: bad page');
  });

  it('returns to debug after the traceback ends', () => {
    // The exception line closes it. What follows is ordinary chatter again.
    const { logger, calls } = recorder();
    const forward = createSidecarLineForwarder(logger);

    for (const line of TRACEBACK) forward(line);
    forward('Creating model: something else');

    expect(calls.warn).toHaveBeenCalledTimes(TRACEBACK.length);
    expect(calls.debug).toHaveBeenCalledTimes(1);
  });

  it('lets a structured line end a traceback', () => {
    // The sidecar recovering and reporting properly means the spill is over.
    const { logger, calls } = recorder();
    const forward = createSidecarLineForwarder(logger);

    forward(TRACEBACK[0] as string);
    forward(JSON.stringify({ level: 'info', msg: 'Sidecar ready' }));
    forward('plain chatter');

    expect(calls.debug).toHaveBeenCalledTimes(1);
  });

  it('does not share the traceback flag between processes', () => {
    // Two sidecars interleave their output; one crashing must not colour the other's lines.
    const { logger, calls } = recorder();
    const first = createSidecarLineForwarder(logger);
    const second = createSidecarLineForwarder(logger);

    first(TRACEBACK[0] as string);
    second('Creating model: unrelated');

    expect(calls.debug).toHaveBeenCalledTimes(1);
    expect(calls.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores blank lines', () => {
    const { logger, calls } = recorder();

    createSidecarLineForwarder(logger)('   ');

    expect(calls.debug).not.toHaveBeenCalled();
    expect(calls.info).not.toHaveBeenCalled();
  });
});
