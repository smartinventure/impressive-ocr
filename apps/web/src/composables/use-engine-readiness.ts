// SPDX-License-Identifier: AGPL-3.0-or-later
import { computed, type ComputedRef } from 'vue';
import { APP_VERSION } from '@impressive-ocr/shared';
import { useLiveStore } from '../stores/live-store';

/**
 * What, if anything, is missing before this installation can OCR well.
 *
 * One place that knows, because three screens ask: the notice in the navigation drawer, the
 * banner on the dashboard, and the System page that does the installing. They disagreed
 * before — the drawer notice was gated on the runtime being *ready*, so an installation with
 * no runtime at all, which is the worst state available, showed nothing anywhere except a
 * small grey "Not installed" chip near the bottom of a page most people never open.
 *
 * There are two separate downloads and the difference is not obvious from their names, which
 * is the other half of the confusion. The **OCR runtime** is Python and PaddleOCR: without it
 * nothing runs. The **fast inference engine** is llama.cpp: without it the accurate profile
 * still works and takes roughly 28 times longer a page. One is a prerequisite, the other is
 * a large optimisation, and telling someone about the second only after they finish the
 * first makes it look like an installation that never ends.
 */
export type EngineGap =
  /** No Python runtime and no PaddleOCR. Nothing can be processed at all. */
  | 'runtime-missing'
  /** The runtime is there; llama.cpp is not, so the accurate profile crawls. */
  | 'fast-engine-missing'
  /** Both present, but the sidecar predates this build of the application. */
  | 'engine-outdated';

export interface EngineReadiness {
  /** The most serious thing missing, or null when there is nothing to say. */
  gap: ComputedRef<EngineGap | null>;
  /** True while an install is running, so nothing nags at someone already watching a bar. */
  installing: ComputedRef<boolean>;
}

export function useEngineReadiness(): EngineReadiness {
  const store = useLiveStore();

  const installing = computed(() => store.runtime?.state === 'installing');

  const gap = computed<EngineGap | null>(() => {
    const runtime = store.runtime;
    if (runtime === null || installing.value) return null;

    // Ordered by what it costs the user, not by which is easiest to fix. Only one is ever
    // shown: a list of everything imperfect is how people learn to ignore the banner.
    if (runtime.state === 'not-installed' || runtime.state === 'failed') return 'runtime-missing';
    if (!store.runtimeReady) return null;
    if (runtime.vlServerInstalled === false) return 'fast-engine-missing';

    const installed = runtime.sidecarVersion ?? null;
    if (installed !== null && installed !== APP_VERSION) return 'engine-outdated';
    return null;
  });

  return { gap, installing };
}
