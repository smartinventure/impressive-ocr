// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single source of truth for every contract crossing a process boundary:
 * server ↔ browser, server ↔ Python sidecar, server ↔ Electron main.
 *
 * This package must not import from `apps/`.
 */

export * from './version';
export * from './common';
export * from './pipeline-options';
export * from './pipeline';
export * from './job';
export * from './system';
export * from './settings';
export * from './auth';
export * from './events';
export * from './sidecar';
