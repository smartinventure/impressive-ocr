import axios from 'axios';

/**
 * Standalone API client for the file browser.
 *
 * In the original project these three calls live inside a much larger shared
 * `services/api.ts`. They are extracted here so the browser can be dropped into
 * a new project as a self-contained unit. If your project already has an axios
 * instance, delete the one below and point `filesystemAPI` at yours instead —
 * only the three endpoints matter.
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Bearer-token auth. Adapt to however your project stores credentials
// (cookies, auth context, etc.).
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface FileItem {
  name: string;
  path: string;
  is_directory: boolean;
  is_file: boolean;
  is_symlink: boolean;
  size: number | null;
  modified: string | null;
  is_borg_repo: boolean;
  is_accessible: boolean;
  permissions: string | null;
}

export interface BrowseResponse {
  success: boolean;
  data: {
    current_path: string;
    parent_path: string;
    is_root: boolean;
    items: FileItem[];
    total_items: number;
  };
}

export const filesystemAPI = {
  // `detectBorg` opts into per-entry Borg-repository detection. It's off by
  // default because the probe is expensive on FUSE/cloud mounts; only the
  // repository picker needs it.
  browse: (
    targetPath: string,
    mode: 'directories' | 'files' | 'both' = 'directories',
    detectBorg = false,
  ) =>
    api.get('/filesystem/browse', {
      params: { path: targetPath, mode, detect_borg: detectBorg ? 'true' : undefined },
    }),

  validatePath: (targetPath: string) => api.post('/filesystem/validate-path', { path: targetPath }),

  createDirectory: (targetPath: string) =>
    api.post('/filesystem/create-directory', { path: targetPath }),
};
