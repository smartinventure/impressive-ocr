// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { absolutePathSchema, byteSizeSchema, pageCountSchema } from './common';

// ---------------------------------------------------------------------------
// Source — what gets picked up, and how
// ---------------------------------------------------------------------------

/**
 * Local folders get native filesystem events. Network shares (UNC, NFS, SMB) do not deliver
 * reliable events, so they must be polled — hence the explicit choice rather than a guess.
 */
export const watchModeSchema = z.enum(['events', 'polling']);
export type WatchMode = z.infer<typeof watchModeSchema>;

export const sourceOptionsSchema = z.object({
  inputPath: absolutePathSchema,
  recursive: z.boolean().default(true),
  /** Recreate the input folder tree under the output folder instead of flattening it. */
  mirrorFolderStructure: z.boolean().default(true),
  includeGlobs: z
    .array(z.string().min(1))
    .default(['**/*.pdf', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.tif', '**/*.tiff']),
  excludeGlobs: z.array(z.string().min(1)).default(['**/~$*', '**/.*']),
  maxFileSizeBytes: byteSizeSchema.default(536_870_912), // 512 MiB
  watchMode: watchModeSchema.default('events'),
  pollIntervalMs: z.number().int().min(1_000).max(3_600_000).default(10_000),
  /** A file must stop changing for this long before it is queued — guards against half-copied files. */
  stabilityWindowMs: z.number().int().min(250).max(600_000).default(2_000),
  /** Skip a file whose content hash was already processed by this pipeline. */
  skipDuplicates: z.boolean().default(false),
});

export type SourceOptions = z.infer<typeof sourceOptionsSchema>;

// ---------------------------------------------------------------------------
// Engine — the accuracy/speed dial
// ---------------------------------------------------------------------------

/**
 * `accurate` = PaddleOCR-VL (0.9B VLM, GPU, best on complex tables and messy scans).
 * `fast`     = PP-StructureV3 + PP-OCRv6 (CPU-viable, good on everyday documents).
 */
export const engineProfileSchema = z.enum(['accurate', 'fast']);
export type EngineProfile = z.infer<typeof engineProfileSchema>;

export const devicePreferenceSchema = z.enum(['auto', 'gpu', 'cpu']);
export type DevicePreference = z.infer<typeof devicePreferenceSchema>;

/** Resolved at job start; `auto` never appears here. */
export const resolvedDeviceSchema = z.enum(['gpu', 'cpu']);
export type ResolvedDevice = z.infer<typeof resolvedDeviceSchema>;

/** PP-OCRv6 size tiers. Ignored by the `accurate` profile, which has a single model. */
export const modelTierSchema = z.enum(['tiny', 'small', 'medium']);
export type ModelTier = z.infer<typeof modelTierSchema>;

/**
 * Per-module toggles. These are the real speed dial — formula and chart recognition are
 * expensive and off by default; table recognition is on because it is why most users are here.
 */
export const engineModulesSchema = z.object({
  docOrientationClassify: z.boolean().default(true),
  docUnwarping: z.boolean().default(false),
  textlineOrientation: z.boolean().default(true),
  tableRecognition: z.boolean().default(true),
  formulaRecognition: z.boolean().default(false),
  chartRecognition: z.boolean().default(false),
  sealRecognition: z.boolean().default(false),
});

export type EngineModules = z.infer<typeof engineModulesSchema>;

export const engineOptionsSchema = z.object({
  profile: engineProfileSchema.default('fast'),
  device: devicePreferenceSchema.default('auto'),
  /** `auto` lets the model detect the script; otherwise a PaddleOCR language code, e.g. `de`. */
  language: z.string().min(2).max(16).default('auto'),
  modelTier: modelTierSchema.default('medium'),
  /** Rasterization DPI for PDF pages. Higher is slower and usually only helps small print. */
  rasterDpi: z.union([z.literal(150), z.literal(200), z.literal(300), z.literal(400)]).default(200),
  /** 0 means "no limit". Guards against a 5,000-page scan blocking the queue. */
  maxPagesPerDocument: pageCountSchema.default(0),
  modules: engineModulesSchema.default({}),
});

export type EngineOptions = z.infer<typeof engineOptionsSchema>;

/**
 * How to treat PDFs that already contain extractable text.
 * `hybrid` is the best default for mixed corpora but costs a per-page probe.
 */
export const textLayerStrategySchema = z.enum(['always-ocr', 'skip-if-text', 'hybrid']);
export type TextLayerStrategy = z.infer<typeof textLayerStrategySchema>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const outputFormatSchema = z.enum([
  'markdown',
  'json',
  'txt',
  'docx',
  'xlsx',
  'html',
  'searchable-pdf',
  'visualization',
]);
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const collisionPolicySchema = z.enum(['overwrite', 'suffix', 'skip']);
export type CollisionPolicy = z.infer<typeof collisionPolicySchema>;

export const outputOptionsSchema = z.object({
  outputPath: absolutePathSchema,
  formats: z.array(outputFormatSchema).min(1).default(['markdown', 'json']),
  /** Supports `{name}`, `{page}`, `{date}`, `{hash}`, `{ext}`. */
  namingTemplate: z.string().min(1).max(256).default('{name}'),
  collisionPolicy: collisionPolicySchema.default('suffix'),
  txtEncoding: z.enum(['utf-8', 'utf-8-bom', 'latin-1']).default('utf-8'),
});

export type OutputOptions = z.infer<typeof outputOptionsSchema>;

/** What happens to the source file once every requested output has been written. */
export const postActionSchema = z.enum(['keep', 'delete', 'move-to-output', 'move-to-archive']);
export type PostAction = z.infer<typeof postActionSchema>;

export const postProcessingOptionsSchema = z
  .object({
    onSuccess: postActionSchema.default('keep'),
    archivePath: absolutePathSchema.optional(),
  })
  .refine((value) => value.onSuccess !== 'move-to-archive' || value.archivePath !== undefined, {
    message: 'archivePath is required when onSuccess is "move-to-archive"',
    path: ['archivePath'],
  });

export type PostProcessingOptions = z.infer<typeof postProcessingOptionsSchema>;

// ---------------------------------------------------------------------------
// Reliability, scheduling, integration
// ---------------------------------------------------------------------------

export const reliabilityOptionsSchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  retryBackoffMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
  /** Failed files are moved here after the final attempt so the input folder stays clean. */
  quarantinePath: absolutePathSchema.optional(),
  concurrency: z.number().int().min(1).max(32).default(1),
});

export type ReliabilityOptions = z.infer<typeof reliabilityOptionsSchema>;

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

export const scheduleOptionsSchema = z
  .object({
    /** Higher runs first. Lets an urgent pipeline jump ahead of a bulk backfill. */
    priority: z.number().int().min(0).max(9).default(5),
    activeHoursEnabled: z.boolean().default(false),
    activeFrom: timeOfDaySchema.default('18:00'),
    activeUntil: timeOfDaySchema.default('07:00'),
  })
  .describe('An active window that wraps past midnight (from > until) is valid and expected.');

export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;

export const integrationOptionsSchema = z.object({
  webhookUrl: z.string().url().max(2048).optional(),
  /** Executed with the job result as JSON on stdin. Empty means disabled. */
  commandOnComplete: z.string().max(2048).optional(),
});

export type IntegrationOptions = z.infer<typeof integrationOptionsSchema>;

// ---------------------------------------------------------------------------
// The whole option set
// ---------------------------------------------------------------------------

export const pipelineOptionsSchema = z.object({
  source: sourceOptionsSchema,
  engine: engineOptionsSchema.default({}),
  textLayerStrategy: textLayerStrategySchema.default('hybrid'),
  output: outputOptionsSchema,
  postProcessing: postProcessingOptionsSchema.default({ onSuccess: 'keep' }),
  reliability: reliabilityOptionsSchema.default({}),
  schedule: scheduleOptionsSchema.default({}),
  integration: integrationOptionsSchema.default({}),
});

export type PipelineOptions = z.infer<typeof pipelineOptionsSchema>;

/**
 * A blank set of options for the pipeline editor: every default, with both paths empty.
 *
 * The obvious way to write this — `pipelineOptionsSchema.parse({ source: { inputPath: '' }, … })`
 * — **throws**, because both paths are `absolutePathSchema`, which is `.min(1)`. Called from a
 * component's setup, that throw aborts rendering and leaves a blank page rather than an empty
 * form. That was exactly the "New pipeline" bug.
 *
 * Parsing with a placeholder and then blanking the two fields keeps a single source of truth
 * for the ~30 defaults while producing the one state the schema deliberately refuses to
 * describe: a form the user has not filled in yet.
 */
export function draftPipelineOptions(): PipelineOptions {
  // Any non-empty string satisfies the path schema; it never leaves this function.
  const placeholder = '/';
  const defaults = pipelineOptionsSchema.parse({
    source: { inputPath: placeholder },
    output: { outputPath: placeholder },
  });

  return {
    ...defaults,
    source: { ...defaults.source, inputPath: '' },
    output: { ...defaults.output, outputPath: '' },
  };
}
