// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import type { AppSettings, HardwareCapabilities } from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';
import { vlServerPaths, type VlServerPaths } from '../../infra/paths';
import { QUANTISATION, selectVlServerBuild } from './vl-server-index';
import type { VlServerProcessOptions } from './vl-server-process';

/**
 * Decides whether the accurate profile can use the batching inference server, and with what.
 *
 * Split out from the pool so the decision is a pure function of settings, hardware and what
 * is on disk — three inputs that are awkward to arrange inside a running pool and trivial to
 * arrange in a test. The pool only has to honour the answer.
 */

export type VlServerUnavailableReason = 'disabled-in-settings' | 'not-installed';

export interface VlServerAvailability {
  /** Options to start it with, or null when it cannot or should not be used. */
  options: VlServerProcessOptions | null;
  reason: VlServerUnavailableReason | null;
}

/**
 * Every layer on the accelerator, or none at all.
 *
 * llama.cpp counts layers rather than taking a device name, and there is no useful middle
 * setting here: a partially offloaded 0.9 B model is slower than either extreme, because
 * every token then crosses the bus twice.
 */
const ALL_LAYERS = 99;
const NO_LAYERS = 0;

export function resolveVlServer(
  settings: AppSettings,
  hardware: HardwareCapabilities,
  vlServerDir: string,
  logger: Logger,
): VlServerAvailability {
  if (settings.vlBackend !== 'llama-cpp') {
    return { options: null, reason: 'disabled-in-settings' };
  }

  const paths = vlServerPaths(vlServerDir, QUANTISATION);
  if (!isInstalled(paths)) {
    // Expected on any installation that predates this feature, so it is not an error — the
    // System page offers the download, and until then the native backend does the work.
    logger.warn(
      { executable: paths.executable },
      'Inference server is not installed; the accurate profile will use the slower built-in backend',
    );
    return { options: null, reason: 'not-installed' };
  }

  return {
    options: {
      executablePath: paths.executable,
      modelPath: paths.model,
      projectorPath: paths.projector,
      concurrency: settings.vlConcurrency,
      // The build was chosen for this machine at install time; asking again here keeps the
      // two consistent when a card is added or removed after the fact.
      gpuLayers: selectVlServerBuild(hardware).accelerator === 'cpu' ? NO_LAYERS : ALL_LAYERS,
      logger,
    },
    reason: null,
  };
}

/** All three files, because a half-finished download must not look like a working install. */
export function isInstalled(paths: VlServerPaths): boolean {
  return existsSync(paths.executable) && existsSync(paths.model) && existsSync(paths.projector);
}
