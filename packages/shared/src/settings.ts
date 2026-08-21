// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { absolutePathSchema } from './common';

/**
 * 8084 rather than the more obvious 8080/8081: those are crowded on a developer machine —
 * 8081 is taken by WSL's relay on Windows, and 8080 by almost every other local server.
 */
export const DEFAULT_PORT = 8084;

/**
 * Binding beyond loopback exposes every watched folder's contents to the network, so it is
 * gated on authentication being enabled (enforced in the settings service, not here).
 */
export const bindAddressSchema = z.enum(['127.0.0.1', '0.0.0.0']);
export type BindAddress = z.infer<typeof bindAddressSchema>;

export const appSettingsSchema = z.object({
  port: z.number().int().min(1024).max(65_535).default(DEFAULT_PORT),
  scheme: z.enum(['http', 'https']).default('http'),
  bindAddress: bindAddressSchema.default('127.0.0.1'),
  authEnabled: z.boolean().default(false),
  /**
   * Folders the user has explicitly authorised. Every pipeline path must resolve inside one of
   * these. Empty means "not configured yet" and blocks all pipelines — deliberately fail-closed.
   */
  folderAllowlist: z.array(absolutePathSchema).default([]),
  openBrowserOnStart: z.boolean().default(true),
  startMinimizedToTray: z.boolean().default(false),
  /**
   * Share of the CPU cores OCR may use, as a percentage.
   *
   * PaddleOCR defaults to every core it can find, which on a laptop means the fan spins up
   * and everything else stops responding. 50 leaves half the machine for the person using it.
   * Applied as a thread cap on the sidecar, not a scheduler priority: fewer threads is the
   * only limit that reduces *memory* as well as CPU, and memory is what actually made the
   * machine swap.
   */
  cpuBudgetPercent: z.number().int().min(10).max(100).default(50),
  /**
   * How many documents may be OCR'd at once, across all pipelines.
   *
   * Each concurrent document means another warm model set resident in RAM -- roughly 2-4 GB
   * for PP-StructureV3. On a 16 GB laptop two is already most of the machine.
   */
  maxConcurrentDocuments: z.number().int().min(1).max(16).default(1),
  /**
   * Minutes an idle OCR worker keeps its models loaded before it is released. 0 keeps it
   * until the application stops.
   *
   * A warm worker is the difference between a second document starting instantly and paying
   * the model load again — forty seconds on a warm GPU box, minutes on a cold CPU one. It is
   * also 3.2 GB of VRAM held while nothing is happening, measured on an 8 GB card, which is
   * most of what a game or a video editor would want. Neither answer is right for everyone,
   * so it is a setting; 0 preserves the behaviour this shipped with.
   */
  sidecarIdleMinutes: z.number().int().min(0).max(1440).default(0),
  /** Days of job history to retain; 0 disables pruning. */
  historyRetentionDays: z.number().int().min(0).max(3650).default(90),
  locale: z.enum(['en', 'de']).default('en'),
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  autoUpdateEnabled: z.boolean().default(true),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;

export const updateSettingsRequestSchema = appSettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** Settings that only take effect after a restart, so the UI can say so. */
export const RESTART_REQUIRED_SETTINGS = ['port', 'scheme', 'bindAddress'] as const;
