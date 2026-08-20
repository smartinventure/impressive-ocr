// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AppSettings,
  CreatePipelineRequest,
  HardwareCapabilities,
  Job,
  JobEvent,
  JobState,
  PipelineWithStatus,
  RuntimeStatus,
  SystemStatus,
  UpdatePipelineRequest,
  UpdateSettingsRequest,
} from '@impressive-ocr/shared';
import { api } from './client';

/**
 * Every backend endpoint, typed from the shared contracts.
 *
 * Components never build URLs — a rename in the backend then breaks the build here rather
 * than at runtime in a view nobody opened during testing.
 */

export interface PagedJobs {
  items: Job[];
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
}

export interface BrowseResult {
  currentPath: string | null;
  parentPath: string | null;
  isRoot: boolean;
  selectable: boolean;
  truncated: boolean;
  entries: FolderEntry[];
}

export interface FolderValidation {
  valid: boolean;
  resolvedPath: string | null;
  message: string | null;
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
  installRuntime: () => api.post<RuntimeStatus>('/system/runtime/install'),
  cancelInstall: () => api.post<{ cancelled: boolean }>('/system/runtime/cancel'),
  pauseAll: () => api.post<{ globallyPaused: boolean }>('/system/pause'),
  resumeAll: () => api.post<{ globallyPaused: boolean }>('/system/resume'),
};

export const settingsApi = {
  get: () => api.get<AppSettings>('/settings'),
  update: (body: UpdateSettingsRequest) => api.patch<AppSettings>('/settings', body),
  validateFolder: (path: string, mustExist = true) =>
    api.post<FolderValidation>('/settings/validate-folder', { path, mustExist }),
};

export const filesystemApi = {
  /**
   * `allowlist` scope is confined to authorised folders; `system` browses the machine and is
   * only permitted locally. Settings uses `system` to choose what to authorise in the first
   * place — the allowlist cannot bootstrap itself.
   */
  browse: (path: string | null, scope: 'allowlist' | 'system' = 'allowlist') => {
    const params = new URLSearchParams({ scope });
    if (path !== null && path.length > 0) {
      params.set('path', path);
    }
    return api.get<BrowseResult>(`/filesystem/browse?${params.toString()}`);
  },
  createFolder: (path: string, scope: 'allowlist' | 'system' = 'allowlist') =>
    api.post<{ path: string }>('/filesystem/create-folder', { path, scope }),
};
