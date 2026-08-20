// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, mapError } from './errors';
import { PathNotAllowedError } from '../infra/fs/safe-path';
import { PipelineValidationError } from '../modules/pipelines/pipeline-service';
import { SettingsValidationError } from '../modules/settings/settings-service';

describe('mapError', () => {
  it('passes an HttpError through unchanged', () => {
    const mapped = mapError(new HttpError(409, 'conflict', 'Already running'));

    expect(mapped).toMatchObject({ statusCode: 409, code: 'conflict', message: 'Already running' });
  });

  it('turns a Zod error into field-level detail', () => {
    const schema = z.object({ port: z.number().min(1024) });
    const error = schema.safeParse({ port: 80 }).error;

    const mapped = mapError(error);

    expect(mapped.statusCode).toBe(400);
    expect(mapped.code).toBe('validation-failed');
    expect(mapped.details?.issues).toEqual([expect.objectContaining({ path: 'port' })]);
  });

  it('reports which pipeline field was rejected so the UI can highlight it', () => {
    const mapped = mapError(
      new PipelineValidationError('This folder does not exist.', 'source.inputPath'),
    );

    expect(mapped.statusCode).toBe(400);
    expect(mapped.details).toEqual({ field: 'source.inputPath' });
  });

  it('rejects an unauthorised path without echoing it back', () => {
    // A probing client must not be able to map the filesystem by watching error messages.
    const mapped = mapError(new PathNotAllowedError('outside-allowlist', 'C:\\Windows\\System32'));

    expect(mapped.statusCode).toBe(403);
    expect(mapped.message).not.toContain('System32');
    expect(JSON.stringify(mapped)).not.toContain('System32');
  });

  it('surfaces the settings guard message, which is actionable', () => {
    const mapped = mapError(new SettingsValidationError('Enable authentication first'));

    expect(mapped).toMatchObject({ statusCode: 400, code: 'settings-invalid' });
  });

  it('hides the detail of an unexpected error', () => {
    // Stack traces and absolute paths stay in the log, not in a response that may cross a LAN.
    const mapped = mapError(new Error('ENOENT: open D:\\secrets\\keys.json'));

    expect(mapped.statusCode).toBe(500);
    expect(mapped.message).not.toContain('secrets');
    expect(mapped.code).toBe('internal-error');
  });

  it('handles a thrown non-Error value', () => {
    expect(mapError('boom')).toMatchObject({ statusCode: 500, code: 'internal-error' });
  });
});
