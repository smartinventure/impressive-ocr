// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Scheduler } from './scheduler';

/**
 * Stopping a run that has already started.
 *
 * Quick Mode's Stop button cancelled only *pending* jobs. For a one-document run that is none
 * of them — the single job is already running by the time the button is on screen — so Stop
 * reported "0 cancelled" and the run went on to completion.
 *
 * `cancelForPipeline` is reached through the private map because that is where the in-flight
 * jobs live; constructing a real scheduler mid-run would mean standing up an executor, a
 * repository and a sidecar to observe one abort.
 */

interface Running {
  jobId: string;
  pipelineId: string;
  device: string;
  controller: AbortController;
}

function schedulerWith(jobs: Running[]): Scheduler {
  const scheduler = Object.create(Scheduler.prototype) as Scheduler;
  const running = new Map(jobs.map((job) => [job.jobId, job]));
  Object.defineProperty(scheduler, 'running', { value: running, writable: false });
  return scheduler;
}

function job(jobId: string, pipelineId: string): Running {
  return { jobId, pipelineId, device: 'gpu', controller: new AbortController() };
}

describe('Scheduler.cancelForPipeline', () => {
  it('aborts the in-flight job for that pipeline', () => {
    const target = job('job-1', 'quick-run');
    const scheduler = schedulerWith([target]);

    const signalled = scheduler.cancelForPipeline('quick-run');

    expect(signalled).toBe(1);
    expect(target.controller.signal.aborted).toBe(true);
  });

  it('leaves other pipelines running', () => {
    // A watched folder mid-document must not be stopped by someone cancelling a Quick run.
    const mine = job('job-1', 'quick-run');
    const theirs = job('job-2', 'watched-folder');
    const scheduler = schedulerWith([mine, theirs]);

    scheduler.cancelForPipeline('quick-run');

    expect(mine.controller.signal.aborted).toBe(true);
    expect(theirs.controller.signal.aborted).toBe(false);
  });

  it('aborts every job of a multi-document run', () => {
    const first = job('job-1', 'quick-run');
    const second = job('job-2', 'quick-run');
    const scheduler = schedulerWith([first, second]);

    expect(scheduler.cancelForPipeline('quick-run')).toBe(2);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
  });

  it('reports nothing when there is nothing in flight', () => {
    const scheduler = schedulerWith([]);

    expect(scheduler.cancelForPipeline('quick-run')).toBe(0);
  });
});
