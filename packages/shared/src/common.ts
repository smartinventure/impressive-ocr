// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

/** Identifiers are ULID-like strings generated server-side; never trust a client-supplied id. */
export const idSchema = z.string().min(1).max(64);

/** ISO-8601 UTC timestamp, e.g. `2026-08-19T09:31:07.482Z`. */
export const isoTimestampSchema = z.string().datetime();

/**
 * An absolute filesystem path as typed by the user.
 *
 * This schema deliberately only rejects the obvious garbage. Real safety comes from
 * canonicalizing the path and checking it against the folder allowlist server-side
 * (`apps/server/src/infra/fs/safe-path.ts`) — never from this regex.
 */
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'Path must not contain null bytes');

export const pageCountSchema = z.number().int().min(0).max(100_000);

export const byteSizeSchema = z.number().int().min(0);

/** Cursor-paginated list envelope used by every collection endpoint. */
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<TItem> {
  items: TItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * What a folder is being chosen for, which decides how it gets tested.
 *
 * An input folder must be readable; an output folder must be writable. Neither is answerable
 * from `stat` alone — on Windows the permission lives in an ACL — so the server proves it by
 * trying, and needs to know which one to try.
 */
export const folderRoleSchema = z.enum(['input', 'output']);
export type FolderRole = z.infer<typeof folderRoleSchema>;

export const folderValidationSchema = z.object({
  valid: z.boolean(),
  resolvedPath: z.string().nullable(),
  /** Why it was rejected. Null when valid. */
  message: z.string().nullable(),
  /**
   * Things worth saying that do not block saving — chiefly that an input folder already holds
   * files, all of which get queued the moment the pipeline starts.
   */
  warnings: z.array(z.string()).default([]),
});

export type FolderValidation = z.infer<typeof folderValidationSchema>;

/** Shape of every error response body. Detail stays server-side; the client gets a code. */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
