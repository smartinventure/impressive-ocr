// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SidecarJobError, describeFailure } from './job-executor';

/**
 * The retry-versus-quarantine decision is the highest-consequence branch in the queue: get
 * it wrong one way and a corrupt file blocks the pipeline forever, get it wrong the other
 * and a transient GPU hiccup throws away someone's document.
 */
describe('describeFailure', () => {
  it('passes a sidecar error through with its own retry decision', () => {
    const result = describeFailure(
      new SidecarJobError('corrupt-document', 'Could not open the PDF', false),
    );

    expect(result).toEqual({
      code: 'corrupt-document',
      message: 'Could not open the PDF',
      retryable: false,
    });
  });

  it('keeps a retryable sidecar error retryable', () => {
    const result = describeFailure(
      new SidecarJobError('out-of-memory', 'CUDA out of memory', true),
    );

    expect(result.retryable).toBe(true);
    expect(result.code).toBe('out-of-memory');
  });

  it('treats a cancellation as retryable rather than a failure', () => {
    // Pausing a pipeline aborts the in-flight request; the document is fine and must come
    // back when the user presses play.
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';

    expect(describeFailure(abort)).toMatchObject({ code: 'cancelled', retryable: true });
  });

  it('defaults an unknown error to retryable', () => {
    // An unrecognised fault is more likely to be transient infrastructure than a
    // permanently broken document, and a wrongly-quarantined file is the worse outcome.
    expect(describeFailure(new Error('socket hang up'))).toMatchObject({
      code: 'internal-error',
      retryable: true,
    });
  });

  it('handles a thrown non-Error value', () => {
    expect(describeFailure('something odd')).toMatchObject({
      code: 'internal-error',
      message: 'something odd',
      retryable: true,
    });
  });
});
