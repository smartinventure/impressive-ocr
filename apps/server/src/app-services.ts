// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppPaths } from './infra/paths';
import type { ResourceMonitor } from './modules/runtime/resource-usage';
import type { AuthService } from './modules/auth/auth-service';
import type { EventBus } from './modules/events/event-bus';
import type { SidecarPool } from './modules/ocr/sidecar-pool';
import type { PipelineService } from './modules/pipelines/pipeline-service';
import type { QuickRunService } from './modules/quick/quick-run-service';
import type { QuickRunStore } from './modules/quick/quick-run-store';
import type { JobRepository } from './modules/queue/job-repository';
import type { Scheduler } from './modules/queue/scheduler';
import type { RuntimeService } from './modules/runtime/runtime-service';
import type { SettingsService } from './modules/settings/settings-service';
import type { WatcherManager } from './modules/watcher/watcher-manager';

/**
 * What the HTTP layer is allowed to reach.
 *
 * Declared as an interface rather than passing the whole container around: routes get exactly
 * the services they need, and adding a dependency to a route is a visible change here rather
 * than a quiet reach into internals.
 */
export interface AppServices {
  pipelines: PipelineService;
  jobs: JobRepository;
  settings: SettingsService;
  auth: AuthService;
  quick: QuickRunService;
  /** Where the log file lives, for the in-app viewer. */
  paths: AppPaths;
  /** Live CPU and memory, sampled between calls. */
  resources: ResourceMonitor;
  quickStore: QuickRunStore;
  runtime: RuntimeService;
  scheduler: Scheduler;
  watchers: WatcherManager;
  pool: SidecarPool;
  events: EventBus;
  isGloballyPaused: () => boolean;
  setGloballyPaused: (paused: boolean) => void;
  /** Canonicalize and authorise a folder, for the editor's inline validation. */
  resolveFolder: (path: string, mustExist: boolean) => Promise<string>;
}
