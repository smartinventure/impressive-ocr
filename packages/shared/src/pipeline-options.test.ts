// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { draftPipelineOptions, pipelineOptionsSchema } from './pipeline-options';
import { appSettingsSchema, DEFAULT_PORT } from './settings';

/**
 * The defaults are a product decision, not an implementation detail.
 *
 * Both the pipeline editor and the server derive a new pipeline by parsing an almost-empty
 * object, so whatever these produce is what every user gets without touching a single
 * control. A silent change here would alter the behaviour of every new pipeline.
 */
describe('pipeline option defaults', () => {
  const defaults = pipelineOptionsSchema.parse({
    source: { inputPath: 'D:\\in' },
    output: { outputPath: 'D:\\out' },
  });

  it('watches subfolders and mirrors the structure into the output', () => {
    expect(defaults.source.recursive).toBe(true);
    expect(defaults.source.mirrorFolderStructure).toBe(true);
  });

  it('waits for a file to stop changing before queueing it', () => {
    // Without this, a large scan still copying over SMB gets picked up half-written.
    expect(defaults.source.stabilityWindowMs).toBeGreaterThanOrEqual(1_000);
  });

  it('uses filesystem events, not polling, on the default local path', () => {
    expect(defaults.source.watchMode).toBe('events');
  });

  it('starts on the CPU-viable profile with automatic device selection', () => {
    expect(defaults.engine.profile).toBe('fast');
    expect(defaults.engine.device).toBe('auto');
  });

  it('turns table recognition on and the expensive modules off', () => {
    // Tables are why most people are here; formulas and charts are slow and rarely wanted.
    expect(defaults.engine.modules.tableRecognition).toBe(true);
    expect(defaults.engine.modules.formulaRecognition).toBe(false);
    expect(defaults.engine.modules.chartRecognition).toBe(false);
    expect(defaults.engine.modules.sealRecognition).toBe(false);
  });

  it('reuses an existing PDF text layer where it can', () => {
    expect(defaults.textLayerStrategy).toBe('hybrid');
  });

  it('never deletes the user files by default', () => {
    // A destructive default is not something anyone should discover after the fact.
    expect(defaults.postProcessing.onSuccess).toBe('keep');
  });

  it('does not overwrite an existing output file by default', () => {
    expect(defaults.output.collisionPolicy).toBe('suffix');
  });

  it('runs one document at a time and retries a few times', () => {
    expect(defaults.reliability.concurrency).toBe(1);
    expect(defaults.reliability.maxAttempts).toBe(3);
  });

  it('rejects an archive action with no archive folder', () => {
    const result = pipelineOptionsSchema.safeParse({
      source: { inputPath: 'D:\\in' },
      output: { outputPath: 'D:\\out' },
      postProcessing: { onSuccess: 'move-to-archive' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty output format list', () => {
    const result = pipelineOptionsSchema.safeParse({
      source: { inputPath: 'D:\\in' },
      output: { outputPath: 'D:\\out', formats: [] },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed active-hours time', () => {
    const result = pipelineOptionsSchema.safeParse({
      source: { inputPath: 'D:\\in' },
      output: { outputPath: 'D:\\out' },
      schedule: { activeFrom: '25:00' },
    });

    expect(result.success).toBe(false);
  });
});

describe('application setting defaults', () => {
  const defaults = appSettingsSchema.parse({});

  it('binds to loopback with no folders authorised', () => {
    // Fail-closed on a fresh install: nothing on the machine is reachable until the user
    // explicitly authorises a folder.
    expect(defaults.bindAddress).toBe('127.0.0.1');
    expect(defaults.folderAllowlist).toEqual([]);
    expect(defaults.authEnabled).toBe(false);
  });

  it('uses port 8084', () => {
    // 8080 and 8081 are both crowded on a developer machine; 8081 is WSL's relay on Windows.
    expect(defaults.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8084);
  });

  it('rejects a privileged port', () => {
    expect(appSettingsSchema.safeParse({ port: 80 }).success).toBe(false);
  });
});

describe('draftPipelineOptions', () => {
  it('does not throw, which is what blanked the "New pipeline" page', () => {
    // The editor calls this during setup. A throw there aborts rendering and the user sees
    // an empty page rather than an empty form.
    expect(() => draftPipelineOptions()).not.toThrow();
  });

  it('leaves both paths empty for the user to fill in', () => {
    const draft = draftPipelineOptions();

    expect(draft.source.inputPath).toBe('');
    expect(draft.output.outputPath).toBe('');
    // No trace of the placeholder used to get past the path validation.
    expect(JSON.stringify(draft)).not.toContain('"/"');
  });

  it('carries the same defaults the schema would produce', () => {
    const draft = draftPipelineOptions();
    const parsed = pipelineOptionsSchema.parse({
      source: { inputPath: 'C:/scans/in' },
      output: { outputPath: 'C:/scans/out' },
    });

    // Everything except the two paths must match, or the form would start from different
    // values than the server.
    expect(draft.engine).toEqual(parsed.engine);
    expect(draft.output.formats).toEqual(parsed.output.formats);
    expect(draft.postProcessing).toEqual(parsed.postProcessing);
    expect(draft.reliability).toEqual(parsed.reliability);
    expect(draft.textLayerStrategy).toBe(parsed.textLayerStrategy);
  });

  it('still fails validation until the user supplies real paths', () => {
    // The draft is a form state, not a valid pipeline: submitting it untouched must be
    // rejected rather than silently creating a pipeline pointing nowhere.
    expect(() => pipelineOptionsSchema.parse(draftPipelineOptions())).toThrow();
  });
});
