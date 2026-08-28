// SPDX-License-Identifier: AGPL-3.0-or-later
import { app } from 'electron';
import { join } from 'node:path';
import { createApp, type AppHandle } from '@impressive-ocr/server';
import { resolveDataDir } from './data-location';

/**
 * Runs the backend inside Electron's main process.
 *
 * Electron's main process *is* Node, so the server is imported and started here rather than
 * spawned as a second executable. One process means one lifecycle, one log stream, and no
 * orphaned backend left running when the app is force-quit — which is exactly what a spawned
 * child tends to leave behind on Windows.
 *
 * `apps/server` knows nothing about Electron; this file is the only adapter.
 */

export interface ServerHost {
  handle: AppHandle;
  url: string;
}

export async function startServer(): Promise<ServerHost> {
  const handle = await createApp({
    // Resolved rather than derived from `userData`: on Windows that is the Roaming half of
    // AppData, which a managed profile synchronises to a file server, and the runtime is
    // eight gigabytes of libraries and model weights. See `data-location.ts`.
    dataDir: resolveDataDir(),
    webRoot: resolveWebRoot(),
    uvBinary: resolveUvBinary(),
    // Passed explicitly: a packaged app is not inside the repository, so the server cannot
    // derive these from its own module location.
    migrationsDir: resolveResource('migrations', join('packages', 'db', 'migrations')),
    sidecarDir: resolveResource('sidecar', 'sidecar'),
    // Honoured here as well as in the headless entry point: a service wrapper or a container
    // sets the port through the environment, and the desktop build is what the "Server"
    // shortcut launches.
    port: parsePort(process.env.IMPRESSIVE_OCR_PORT),
    pretty: !app.isPackaged,
  });

  const url = await handle.listen();
  return { handle, url };
}

/**
 * The built SPA.
 *
 * Packaged, it lives next to the app in `resources`; in development it is the Vite build
 * output in the workspace. `process.resourcesPath` is only meaningful once packaged.
 */
function resolveWebRoot(): string {
  return resolveResource('web', join('apps', 'web', 'dist'));
}

/**
 * A path that moves between the workspace and the packaged `resources` directory.
 *
 * `packagedName` is relative to `process.resourcesPath`; `workspacePath` is relative to the
 * repository root.
 */
function resolveResource(packagedName: string, workspacePath: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, packagedName)
    : join(repositoryRoot(), workspacePath);
}

/** `app.getAppPath()` is `apps/desktop` when running unpackaged. */
function repositoryRoot(): string {
  return join(app.getAppPath(), '..', '..');
}

/** A malformed value is ignored rather than fatal — the stored setting is a fine fallback. */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : undefined;
}

/**
 * The bundled `uv`, which installs Python and PaddleOCR on first run.
 *
 * Unpacked from the asar — it has to be executable, and an executable inside an asar archive
 * cannot be spawned.
 */
function resolveUvBinary(): string {
  const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return join(resolveResource('uv', join('vendor', `uv-${process.arch}`)), binary);
}
