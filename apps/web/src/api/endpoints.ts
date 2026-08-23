// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AppSettings,
  QuickOptions,
  QuickRun,
  FolderRole,
  FolderValidation,
  AuthStatus,
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
}

export interface BrowseResult {
  currentPath: string | null;
  parentPath: string | null;
  isRoot: boolean;
  selectable: boolean;
  truncated: boolean;
  entries: FolderEntry[];
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
  cancelInstall: () => api.post<{ cancelled: boolean }>('/system/runtime/cancel'),
  /** Stop the warm OCR workers and give their model memory back. */
  releaseSidecars: (force: boolean) =>
    api.post<SidecarReleaseResult>('/system/sidecars/release', { force }),
  pauseAll: () => api.post<{ globallyPaused: boolean }>('/system/pause'),
  resumeAll: () => api.post<{ globallyPaused: boolean }>('/system/resume'),
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

  start: (body: {
    source: 'server' | 'upload';
    files?: string[];
    uploadId?: string;
    outputPath?: string;
    options: QuickOptions;
  }): Promise<QuickRun> => api.post('/quick/runs', body),

  progress: (pipelineId: string, signal?: AbortSignal): Promise<QuickRunProgress> =>
    api.get(`/quick/runs/${pipelineId}`, signal),

  cancel: (pipelineId: string): Promise<{ cancelled: number }> =>
    api.post(`/quick/runs/${pipelineId}/cancel`),

  /** Absolute URL, because this is handed to the browser to download rather than fetched. */
  downloadUrl: (pipelineId: string): string => `/api/quick/runs/${pipelineId}/download`,

  discard: (pipelineId: string, runId: string): Promise<void> =>
    api.delete(`/quick/runs/${pipelineId}?runId=${encodeURIComponent(runId)}`),
};

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
