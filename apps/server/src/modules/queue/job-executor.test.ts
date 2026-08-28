// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { NoOutputError, SidecarJobError, describeFailure } from './job-executor';

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

/**
 * A job that produced nothing.
 *
 * `formats` is `.min(1)`, so at least one output was always asked for and an empty set can
 * only mean a writer produced none. That has happened twice — a missing `python-docx`, and
 * every page coming from a PDF's own text layer — and both times the job was marked
 * succeeded beside an empty folder.
 *
 * The severity is in what runs next: `onSuccess` can be `delete`, so the code path that
 * reported a phantom success is the same one that removes the user's original.
 */
describe('describeFailure for a job with no output', () => {
  it('does not retry, because the next attempt would produce nothing too', () => {
    const described = describeFailure(new NoOutputError());

    expect(described.retryable).toBe(false);
    expect(described.code).toBe('no-output');
  });

  it('says the source was left alone', () => {
    // The one thing the user needs to know: their document is still there.
    expect(describeFailure(new NoOutputError()).message).toContain('left in place');
  });

  it('still retries an ordinary error', () => {
    expect(describeFailure(new Error('socket hang up')).retryable).toBe(true);
  });
});
