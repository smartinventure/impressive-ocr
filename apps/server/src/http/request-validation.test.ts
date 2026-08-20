// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createPipelineRequestSchema } from '@impressive-ocr/shared';
import { mapError } from './errors';

/**
 * Guards the boundary between `@impressive-ocr/shared` and the server's own copy of zod.
 *
 * Under pnpm these can end up as two distinct module instances, which silently breaks
 * `instanceof ZodError` in the error handler and turns every field-level validation message
 * into a useless generic one. The symptom is invisible in a unit test of either package
 * alone, so it is pinned down here.
 */
describe('request validation across the shared-package boundary', () => {
  const validBody = {
    name: 'Invoices',
    options: {
      source: { inputPath: 'D:\\scans\\in' },
      output: { outputPath: 'D:\\scans\\out' },
    },
  };

  it('accepts a minimal pipeline body and fills in the defaults', () => {
    const parsed = createPipelineRequestSchema.parse(validBody);

    expect(parsed.enabled).toBe(true);
    expect(parsed.options.engine.profile).toBe('fast');
    expect(parsed.options.output.formats).toEqual(['markdown', 'json']);
    expect(parsed.options.textLayerStrategy).toBe('hybrid');
  });

  it('throws an error the server error handler recognises as a ZodError', () => {
    let thrown: unknown;
    try {
      createPipelineRequestSchema.parse({ name: '', options: {} });
    } catch (error) {
      thrown = error;
    }

    // The instanceof check the handler relies on must hold across the package boundary.
    expect(thrown).toBeInstanceOf(ZodError);
  });

  it('reports the offending field paths rather than a generic message', () => {
    let thrown: unknown;
    try {
      createPipelineRequestSchema.parse({ name: 'x', options: { source: {}, output: {} } });
    } catch (error) {
      thrown = error;
    }

    const mapped = mapError(thrown);

    expect(mapped.statusCode).toBe(400);
    expect(mapped.message).toBe('The request body is not valid.');
    const paths = (mapped.details?.issues as { path: string }[]).map((issue) => issue.path);
    expect(paths).toContain('options.source.inputPath');
    expect(paths).toContain('options.output.outputPath');
  });
});
