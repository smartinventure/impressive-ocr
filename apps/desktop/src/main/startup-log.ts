// SPDX-License-Identifier: AGPL-3.0-or-later
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file log for the main process.
 *
 * Not a nicety on Windows: Electron is linked as a GUI-subsystem binary, so it has no console
 * to write to even when launched from one. In headless server mode that means `stdout` goes
 * nowhere — a startup failure produces a process that appears to run and does nothing, with
 * no way to find out why.
 *
 * Written synchronously and with no dependencies, because the whole point is to survive
 * failures that happen before anything else is initialised.
 */

let logPath: string | null = null;

export function initStartupLog(): string {
  const directory = join(app.getPath('userData'), 'logs');
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // If even this fails there is nowhere to record it; continue and let stdout try.
  }
  logPath = join(directory, 'main.log');
  logLine(`--- Impressive OCR ${app.getVersion()} starting (${process.platform}) ---`);
  return logPath;
}

export function logLine(message: string): void {
  const line = `${new Date().toISOString()}  ${message}\n`;
  // Both: the file is the reliable channel, stdout helps on macOS and Linux where it works.
  process.stdout.write(line);
  if (logPath === null) {
    return;
  }
  try {
    appendFileSync(logPath, line);
  } catch {
    // A full or read-only disk must not take down the app on its way up.
  }
}

export function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logLine(`ERROR ${context}: ${detail}`);
}

/**
 * Record what would otherwise vanish.
 *
 * Without this, an async failure in the main process on Windows leaves no trace at all.
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => logError('uncaughtException', error));
  process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
}

export function getLogPath(): string | null {
  return logPath;
}
