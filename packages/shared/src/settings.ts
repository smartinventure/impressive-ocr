// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { absolutePathSchema } from './common';

export const DEFAULT_PORT = 8081;

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
