// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PipelineValidationError, assertNotNested } from './pipeline-service';

/**
 * The self-feeding pipeline is one of the easiest configuration mistakes to make and one of
 * the most expensive to discover — every result written lands back in the watched folder,
 * gets picked up as new input, and the loop runs until the disk fills.
 */
describe('assertNotNested', () => {
  it('accepts sibling folders', () => {
    expect(() => assertNotNested('D:\\scans\\in', 'D:\\scans\\out')).not.toThrow();
  });

  it('rejects an output folder directly inside the input folder', () => {
    expect(() => assertNotNested('D:\\scans', 'D:\\scans\\out')).toThrow(PipelineValidationError);
  });

  it('rejects an output folder deeper inside the input folder', () => {
    expect(() => assertNotNested('D:\\scans', 'D:\\scans\\2024\\out')).toThrow(
      PipelineValidationError,
    );
  });

  it('rejects identical input and output folders', () => {
    expect(() => assertNotNested('D:\\scans', 'D:\\scans')).toThrow(PipelineValidationError);
  });

  it('accepts an output folder whose name merely shares a prefix', () => {
    // `D:\scans-out` is a sibling of `D:\scans`, not a child — a naive startsWith would
    // wrongly reject this perfectly sensible setup.
    expect(() => assertNotNested('D:\\scans', 'D:\\scans-out')).not.toThrow();
  });

  it('accepts the input folder nested inside the output folder', () => {
    // Only the reverse direction loops. This arrangement is unusual but harmless.
    expect(() => assertNotNested('D:\\archive\\in', 'D:\\archive')).not.toThrow();
  });

  it('ignores trailing separators', () => {
    expect(() => assertNotNested('D:\\scans\\', 'D:\\scans\\out\\')).toThrow(
      PipelineValidationError,
    );
  });

  it('handles forward slashes', () => {
    expect(() => assertNotNested('/data/scans', '/data/scans/out')).toThrow(
      PipelineValidationError,
    );
  });

  it('names the offending field so the UI can highlight it', () => {
    try {
      assertNotNested('D:\\scans', 'D:\\scans\\out');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineValidationError);
      expect((error as PipelineValidationError).field).toBe('output.outputPath');
    }
  });
});
