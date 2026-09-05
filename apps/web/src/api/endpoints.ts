// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AppSettings,
  QuickOptions,
  QuickRun,
  QuickRunFile,
  FolderRole,
  FolderValidation,
  AuthStatus,
  ConsentStatus,
  ServerUpdateStatus,
  ServerUpdateTriggerResult,
  SetPasswordRequest,
  CreatePipelineRequest,
  HardwareCapabilities,
  Job,
  JobEvent,
  JobListItem,
  JobState,
  PipelineWithStatus,
  RuntimeInstallPlan,
  PreflightReport,
  RuntimeStatus,
  SidecarReleaseResult,
  SystemStatus,
  UpdatePipelineRequest,
  UpdateSettingsRequest,
} from '@impressive-ocr/shared';
import type {
  ActivateLicenseRequest,
  LicenseStatus,
  RegisterPersonalRequest,
} from '@impressive-ocr/shared';
import { api, uploadFiles } from './client';

/**
 * Every backend endpoint, typed from the shared contracts.
 *
 * Components never build URLs — a rename in the backend then breaks the build here rather
 * than at runtime in a view nobody opened during testing.
 */

export interface PagedJobs {
  items: JobListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface HardwareWithExplanation extends HardwareCapabilities {
  /** Server-rendered prose, so the same wording appears in the wizard and on the status screen. */
  explanation: string | null;
}

export interface FolderEntry {
  name: string;
  path: string;
  isAccessible: boolean;
  modifiedAt: string | null;
  selectable: boolean;
  /** Files appear only when `includeFiles` was requested; folders always do. */
  isDirectory: boolean;
  sizeBytes: number | null;
  /**
   * The folder as it exists on the operator's own machine, when this server runs in a
   * container started with the host mounted at `/host`.
   *
   * Null on every desktop installation and for anything outside that mount. Display only:
   * `path` is what pipelines store and what the OCR sidecar is given, because the sidecar
   * runs inside the container and `/mnt/scans` means nothing there.
   */
  hostPath: string | null;
}

export interface BrowseResult {
  currentPath: string | null;
  parentPath: string | null;
  isRoot: boolean;
  selectable: boolean;
  truncated: boolean;
  entries: FolderEntry[];
  /** `currentPath` as the operator knows it; see `FolderEntry.hostPath`. */
  hostPath: string | null;
}

export const pipelinesApi = {
  list: () => api.get<PipelineWithStatus[]>('/pipelines'),
  get: (id: string) => api.get<PipelineWithStatus>(`/pipelines/${id}`),
  create: (body: CreatePipelineRequest) => api.post<PipelineWithStatus>('/pipelines', body),
  update: (id: string, body: UpdatePipelineRequest) =>
    api.patch<PipelineWithStatus>(`/pipelines/${id}`, body),
  remove: (id: string) => api.delete(`/pipelines/${id}`),
  pause: (id: string) => api.post<PipelineWithStatus>(`/pipelines/${id}/pause`),
  resume: (id: string) => api.post<PipelineWithStatus>(`/pipelines/${id}/resume`),
};

export const jobsApi = {
  list: (
    query: { pipelineId?: string; state?: JobState; limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return api.get<PagedJobs>(`/jobs${suffix}`);
  },
  get: (id: string) => api.get<Job>(`/jobs/${id}`),
  events: (id: string) => api.get<JobEvent[]>(`/jobs/${id}/events`),
  retry: (id: string) => api.post<Job>(`/jobs/${id}/retry`),
  cancel: (id: string) =>
    api.post<{ cancelled: boolean; wasRunning: boolean }>(`/jobs/${id}/cancel`),

  /**
   * Remove finished jobs from the history.
   *
   * `state` clears just one of them -- the failures, say -- and is rejected by the server for
   * anything still queued or running.
   */
  /** How many rows a clear would take, for the confirmation. */
  clearable: (state?: JobState): Promise<{ clearable: number }> =>
    api.get(`/jobs/clearable${state === undefined ? '' : `?state=${state}`}`),

  clear: (state?: JobState): Promise<{ cleared: number }> =>
    api.delete(`/jobs${state === undefined ? '' : `?state=${state}`}`),
};

export const systemApi = {
  status: () => api.get<SystemStatus>('/system/status'),
  hardware: () => api.get<HardwareWithExplanation>('/system/hardware'),
  probeHardware: () => api.post<HardwareCapabilities>('/system/hardware/probe'),
  runtime: () => api.get<RuntimeStatus>('/system/runtime'),
  /** What an install would download. Shown for confirmation before one is started. */
  runtimePlan: () => api.get<RuntimeInstallPlan>('/system/runtime/plan'),

  /** Can this machine run the engine? Probes the CPU, so it is asked for, not polled. */
  preflight: () => api.get<PreflightReport>('/system/preflight'),
  installRuntime: () => api.post<RuntimeStatus>('/system/runtime/install'),
  /** Reinstall just the sidecar. Seconds, and downloads nothing. */
  refreshSidecar: () => api.post<RuntimeStatus>('/system/runtime/refresh'),
  /** Add the fast inference engine to a runtime installed before it existed. */
  installVlServer: () => api.post<RuntimeStatus>('/system/runtime/vl-server'),
  cancelInstall: () => api.post<{ cancelled: boolean }>('/system/runtime/cancel'),
  /** Stop the warm OCR workers and give their model memory back. */
  releaseSidecars: (force: boolean) =>
    api.post<SidecarReleaseResult>('/system/sidecars/release', { force }),
  pauseAll: () => api.post<{ globallyPaused: boolean }>('/system/pause'),
  resumeAll: () => api.post<{ globallyPaused: boolean }>('/system/resume'),
};

export const consentApi = {
  get: () => api.get<ConsentStatus>('/consent'),
  accept: (version: number) => api.post<ConsentStatus>('/consent/accept', { version }),
};

/**
 * Updating the headless server. The desktop app uses electron-updater and never calls these.
 *
 * `trigger` answers 409 when no host updater is installed, which the composable turns into
 * the manual command rather than an error.
 */
export const updateApi = {
  check: () => api.get<ServerUpdateStatus>('/update/check'),
  trigger: () => api.post<ServerUpdateTriggerResult>('/update/trigger'),
};

export const settingsApi = {
  get: () => api.get<AppSettings>('/settings'),
  update: (body: UpdateSettingsRequest) => api.patch<AppSettings>('/settings', body),
  validateFolder: (path: string, mustExist = true, role?: FolderRole) =>
    api.post<FolderValidation>('/settings/validate-folder', { path, mustExist, role }),
};

export const filesystemApi = {
  /**
   * `allowlist` scope is confined to authorised folders; `system` browses the machine and is
   * only permitted locally. Settings uses `system` to choose what to authorise in the first
   * place — the allowlist cannot bootstrap itself.
   */
  browse: (
    path: string | null,
    scope: 'allowlist' | 'system' = 'allowlist',
    includeFiles = false,
  ) => {
    const params = new URLSearchParams({ scope });
    if (path !== null && path.length > 0) {
      params.set('path', path);
    }
    if (includeFiles) {
      params.set('includeFiles', 'true');
    }
    return api.get<BrowseResult>(`/filesystem/browse?${params.toString()}`);
  },
  createFolder: (path: string, scope: 'allowlist' | 'system' = 'allowlist') =>
    api.post<{ path: string }>('/filesystem/create-folder', { path, scope }),

  /** Add a folder the user has explicitly chosen to the allowlist. */
  authorizeFolder: (path: string) =>
    api.post<{ folderAllowlist: string[] }>('/filesystem/authorize-folder', { path }),
};

/** Sign-in, sign-out and password management. */
export const authApi = {
  status: (signal?: AbortSignal): Promise<AuthStatus> => api.get('/auth/status', signal),

  login: (password: string): Promise<{ csrfToken: string }> =>
    api.post('/auth/login', { password }),

  logout: (): Promise<{ ok: boolean }> => api.post('/auth/logout'),

  setPassword: (body: SetPasswordRequest): Promise<{ ok: boolean }> =>
    api.put('/auth/password', body),

  clearPassword: (): Promise<void> => api.delete('/auth/password'),
};

/** Quick Mode: OCR a handful of files once, without a watched folder. */
export const quickApi = {
  /** Stage uploads first, so progress is visible and a failed upload never creates a run. */
  upload: (files: File[], onProgress?: (fraction: number) => void): Promise<{ uploadId: string }> =>
    uploadFiles('/api/quick/uploads', files, onProgress),

  /**
   * What a folder holds, so the picker can show a count and offer only the types present.
   *
   * Per folder rather than for the whole selection: folders are added one at a time, and
   * re-counting every one of them each time another is added would grow quadratically on a
   * network share.
   */
  folderPreview: (path: string, signal?: AbortSignal): Promise<QuickFolderPreview> =>
    api.get(`/quick/folder-preview?path=${encodeURIComponent(path)}`, signal),

  start: (body: {
    source: 'server' | 'upload';
    files?: string[];
    /** Folders to take the files from, expanded on the server. Exclusive with `files`. */
    folderPaths?: string[];
    /** Which types to take from those folders, without the dot. */
    extensions?: string[];
    uploadId?: string;
    outputPath?: string;
    options: QuickOptions;
  }): Promise<QuickRun> => api.post('/quick/runs', body),

  progress: (pipelineId: string, signal?: AbortSignal): Promise<QuickRunProgress> =>
    api.get(`/quick/runs/${pipelineId}`, signal),

  /** Everything the run produced, so each file can be offered on its own. */
  files: (pipelineId: string, signal?: AbortSignal): Promise<QuickRunFile[]> =>
    api.get(`/quick/runs/${pipelineId}/files`, signal),

  /**
   * A single result, addressed by its position in the server's list.
   *
   * Not a path: the client never names a file on disk, which is what keeps a download button
   * from becoming a traversal.
   */
  fileUrl: (pipelineId: string, index: number): string =>
    `/api/quick/runs/${pipelineId}/files/${index}`,

  cancel: (pipelineId: string): Promise<{ cancelled: number }> =>
    api.post(`/quick/runs/${pipelineId}/cancel`),

  /** Absolute URL, because this is handed to the browser to download rather than fetched. */
  downloadUrl: (pipelineId: string): string => `/api/quick/runs/${pipelineId}/download`,

  discard: (pipelineId: string, runId: string): Promise<void> =>
    api.delete(`/quick/runs/${pipelineId}?runId=${encodeURIComponent(runId)}`),
};

export interface QuickFolderPreview {
  path: string;
  /** Only the types the folder actually holds, in a stable order. */
  counts: { extension: string; files: number }[];
  /** Files the engine cannot read, so a count smaller than the folder is explainable. */
  other: number;
}

export interface QuickRunProgress {
  pipelineId: string;
  stats: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    quarantined: number;
    total: number;
  };
  jobs: Job[];
}

/**
 * Registration and entitlement.
 *
 * The status endpoint is safe to call from anywhere: it never returns the licence key, only a
 * masked form of it.
 */
export const licenseApi = {
  get: (): Promise<LicenseStatus> => api.get('/license'),

  /**
   * The countries registration accepts.
   *
   * Null when the licence server could not be asked, which is the signal to use the bundled
   * list rather than render an empty dropdown.
   */
  countries: (): Promise<{ code: string; name: string }[] | null> => api.get('/license/countries'),

  /** Personal tier. Returns with the state `awaiting-key`: the key arrives by email. */
  registerPersonal: (body: RegisterPersonalRequest): Promise<LicenseStatus> =>
    api.post('/license/personal', body),

  /** Both tiers. The key came by email, or with a purchase. */
  activate: (body: ActivateLicenseRequest): Promise<LicenseStatus> =>
    api.post('/license/activate', body),

  /** Hand this machine's seat back so another can take it. */
  release: (): Promise<LicenseStatus> => api.post('/license/release', { confirm: true }),
};

/** The application log, for the in-app viewer. */
export const logsApi = {
  tail: (): Promise<LogTailResponse> => api.get('/logs'),
  clear: (): Promise<void> => api.delete('/logs'),
};

export interface LogTailResponse {
  text: string;
  truncated: boolean;
  totalBytes: number;
  files: { name: string; bytes: number }[];
}

/** The overview screen, in one request rather than four. */
export const dashboardApi = {
  get: (hours = 24): Promise<DashboardSnapshot> => api.get(`/dashboard?hours=${hours}`),
};

export interface DashboardSnapshot {
  windowHours: number;
  resources: {
    cpuBusyFraction: number | null;
    totalMemoryBytes: number;
    freeMemoryBytes: number;
    memoryUsedFraction: number;
    processMemoryBytes: number;
  };
  hardware: HardwareCapabilities;
  runtime: { state: string; device: string | null };
  platform: { support: 'native' | 'emulated' | 'unsupported'; reason: string };
  throughput: { succeeded: number; failed: number; quarantined: number; pages: number };
  pipelines: {
    id: string;
    name: string;
    enabled: boolean;
    status: string;
    inputPath: string;
    outputPath: string;
    formats: string[];
    profile: string;
    stats: { queued: number; running: number; succeeded: number; failed: number };
  }[];
}
