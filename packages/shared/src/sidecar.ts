// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { byteSizeSchema, pageCountSchema } from './common';
import {
  engineOptionsSchema,
  engineProfileSchema,
  outputFormatSchema,
  outputOptionsSchema,
  resolvedDeviceSchema,
  textLayerStrategySchema,
} from './pipeline-options';

/**
 * Contract between the Node backend and the Python OCR sidecar.
 *
 * Kept here rather than in the server so the Python side can be regenerated from — and
 * validated against — the same definition. Transport is NDJSON over loopback HTTP: one JSON
 * object per line, so the backend gets page-level progress without buffering a whole document.
 */

export const SIDECAR_PROTOCOL_VERSION = 1;
export const SIDECAR_AUTH_HEADER = 'x-impressive-ocr-token';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const sidecarJobRequestSchema = z.object({
  jobId: z.string().min(1),
  /** Absolute path, already canonicalized and allowlist-checked by the backend. */
  sourcePath: z.string().min(1),
  /** Temp directory the sidecar writes into; the backend moves the results atomically. */
  workDir: z.string().min(1),
  /** Basename (no extension) the writers should use for their output files. */
  outputStem: z.string().min(1),
  profile: engineProfileSchema,
  device: resolvedDeviceSchema,
  engine: engineOptionsSchema,
  textLayerStrategy: textLayerStrategySchema,
  formats: z.array(outputFormatSchema).min(1),
  /** Only the `txt` writer reads this; every other format ignores it. */
  txtEncoding: outputOptionsSchema.shape.txtEncoding,
});

export type SidecarJobRequest = z.infer<typeof sidecarJobRequestSchema>;

// ---------------------------------------------------------------------------
// NDJSON response stream
// ---------------------------------------------------------------------------

export const sidecarMessageSchema = z.discriminatedUnion('type', [
  /** Emitted once the document has been opened and the page count is known. */
  z.object({
    type: z.literal('accepted'),
    jobId: z.string(),
    pageCount: pageCountSchema,
  }),
  z.object({
    type: z.literal('page'),
    jobId: z.string(),
    page: pageCountSchema,
    pageCount: pageCountSchema,
    /** True when `skip-if-text`/`hybrid` reused the PDF's existing text layer for this page. */
    usedExistingTextLayer: z.boolean().default(false),
    elapsedMs: z.number().min(0),
  }),
  z.object({
    type: z.literal('log'),
    jobId: z.string(),
    level: z.enum(['debug', 'info', 'warning', 'error']),
    message: z.string().max(2000),
    page: pageCountSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal('output'),
    jobId: z.string(),
    format: outputFormatSchema,
    /** Relative to `workDir`. */
    path: z.string().min(1),
    bytes: byteSizeSchema,
  }),
  z.object({
    type: z.literal('done'),
    jobId: z.string(),
    pageCount: pageCountSchema,
    durationMs: z.number().min(0),
  }),
  z.object({
    type: z.literal('error'),
    jobId: z.string(),
    code: z.string().max(120),
    message: z.string().max(2000),
    /** False for corrupt input or an unsupported format — retrying would waste the queue's time. */
    retryable: z.boolean(),
  }),
]);

export type SidecarMessage = z.infer<typeof sidecarMessageSchema>;
export type SidecarMessageType = SidecarMessage['type'];
export type SidecarMessageOf<TType extends SidecarMessageType> = Extract<
  SidecarMessage,
  { type: TType }
>;

// ---------------------------------------------------------------------------
// Health & capabilities
// ---------------------------------------------------------------------------

export const sidecarHealthResponseSchema = z.object({
  status: z.enum(['starting', 'ready', 'busy']),
  protocolVersion: z.number().int(),
  uptimeSeconds: z.number().min(0),
});

export type SidecarHealthResponse = z.infer<typeof sidecarHealthResponseSchema>;

export const sidecarCapabilitiesResponseSchema = z.object({
  protocolVersion: z.number().int(),
  pythonVersion: z.string(),
  paddleVersion: z.string(),
  paddleocrVersion: z.string(),
  device: resolvedDeviceSchema,
  profile: engineProfileSchema,
  /** Formats this build can actually emit — depends on optional Python extras being present. */
  supportedFormats: z.array(outputFormatSchema),
});

export type SidecarCapabilitiesResponse = z.infer<typeof sidecarCapabilitiesResponseSchema>;
