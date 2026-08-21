// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { isoTimestampSchema } from './common';

/**
 * Can this machine run the OCR runtime at all, and if not, what would fix it?
 *
 * Two different questions live here and the distinction is the whole point:
 *
 * - **fixable** — something is missing that an install can supply. A machine without the
 *   Microsoft Visual C++ runtime is one download away from working.
 * - **blocked** — no amount of installing helps. A CPU without AVX cannot execute the
 *   PaddlePaddle wheel's instructions, and there is no wheel that would change that.
 *
 * Collapsing the two would be worse than useless: a checker that only understood "missing
 * things" would install the redistributable on a non-AVX machine, report success, and then
 * fail anyway several gigabytes later.
 */

export const preflightSeveritySchema = z.enum(['ok', 'fixable', 'blocked']);
export type PreflightSeverity = z.infer<typeof preflightSeveritySchema>;

export const preflightCheckIdSchema = z.enum([
  /** Emulated ARM, or an OS/architecture with no PaddlePaddle wheel at all. */
  'platform',
  /** The CPU's instruction set versus what the wheel was compiled for. */
  'cpu-avx',
  /** The Microsoft Visual C++ runtime that PaddlePaddle's own DLLs link against. */
  'vc-runtime',
  /** The bundled `uv` binary, without which the OCR runtime cannot be installed at all. */
  'ocr-installer',
  /** Room for the interpreter, the wheels and the model weights. */
  'disk-space',
]);
export type PreflightCheckId = z.infer<typeof preflightCheckIdSchema>;

/**
 * How a user resolves a `fixable` check.
 *
 * Instructions are a list of steps rather than a paragraph so the UI can render them as an
 * ordered list, and so translators are not handed a wall of prose with embedded formatting.
 */
export const preflightRemedySchema = z.object({
  summary: z.string().max(200),
  /** Where to get it, when a download is what is needed. Null for "free up disk space". */
  downloadUrl: z.string().url().nullable(),
  steps: z.array(z.string().max(300)).max(10),
});
export type PreflightRemedy = z.infer<typeof preflightRemedySchema>;

export const preflightCheckSchema = z.object({
  id: preflightCheckIdSchema,
  severity: preflightSeveritySchema,
  title: z.string().max(120),
  /**
   * Plain-language explanation, built server-side.
   *
   * Same reasoning as `describeGpuReason`: one wording, in one place, so the UI never has to
   * turn a reason code into a sentence and the log and the screen cannot disagree.
   */
  detail: z.string().max(1000),
  remedy: preflightRemedySchema.nullable(),
});
export type PreflightCheck = z.infer<typeof preflightCheckSchema>;

export const preflightReportSchema = z.object({
  /** True when nothing is `blocked`. Fixable items still allow an attempt. */
  canInstall: z.boolean(),
  /** True when at least one check is `fixable`, so the UI can offer guidance. */
  hasFixable: z.boolean(),
  checks: z.array(preflightCheckSchema),
  checkedAt: isoTimestampSchema,
});
export type PreflightReport = z.infer<typeof preflightReportSchema>;

/**
 * Raised when an install is attempted on a machine that cannot run the result.
 *
 * Exported here rather than in the server so the message the user sees is defined alongside
 * the contract that produced it.
 */
export const PREFLIGHT_BLOCKED_MESSAGE =
  'This machine cannot run the OCR engine. See the System page for details.';
