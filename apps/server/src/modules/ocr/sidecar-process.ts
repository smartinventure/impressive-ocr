// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineProfile, ResolvedDevice } from '@impressive-ocr/shared';
import { logSidecarLine, type Logger } from '../../infra/logger';

/**
 * Owns one Python sidecar process: start it, learn its port, watch it, stop it.
 *
 * The port is discovered rather than assigned. The sidecar binds port 0, lets the OS pick a
 * free one, and prints a single JSON handshake line on stdout. Choosing a port ourselves
 * would mean racing anything else on the machine and failing on a user who already runs
 * something there.
 */

/** A model load can legitimately take minutes on a cold cache; the handshake cannot. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

export interface SidecarProcessOptions {
  pythonPath: string;
  profile: EngineProfile;
  device: ResolvedDevice;
  authToken: string;
  modelCacheDir: string;
  logLevel: string;
  logger: Logger;
}

export interface SidecarHandshake {
  port: number;
  protocolVersion: number;
}

export class SidecarStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarStartupError';
  }
}

export class SidecarProcess {
  private child: ChildProcess | null = null;
  private handshake: SidecarHandshake | null = null;
  private exited = false;

  constructor(private readonly options: SidecarProcessOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get port(): number | null {
    return this.handshake?.port ?? null;
  }

  /**
   * Start the process and resolve once it reports its port.
   *
   * Rejects rather than resolving on a crashed start, so the pool can surface a real error
   * instead of handing out a worker that will fail every job.
   */
  async start(): Promise<SidecarHandshake> {
    if (this.child !== null) {
      throw new SidecarStartupError('Sidecar already started');
    }

    const child = spawn(this.options.pythonPath, ['-m', 'impressive_ocr_sidecar'], {
      env: {
        ...process.env,
        IMPRESSIVE_OCR_HOST: '127.0.0.1',
        IMPRESSIVE_OCR_PORT: '0',
        IMPRESSIVE_OCR_TOKEN: this.options.authToken,
        IMPRESSIVE_OCR_PROFILE: this.options.profile,
        IMPRESSIVE_OCR_DEVICE: this.options.device,
        IMPRESSIVE_OCR_MODEL_CACHE_DIR: this.options.modelCacheDir,
        IMPRESSIVE_OCR_LOG_LEVEL: this.options.logLevel,
        // Unbuffered, or the handshake line can sit in Python's stdout buffer and the
        // start times out even though the process is healthy.
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.exited = false;

    child.once('exit', (code, signal) => {
      this.exited = true;
      this.options.logger.warn(
        { pid: child.pid, code, signal, profile: this.options.profile },
        'Sidecar exited',
      );
    });

    this.pipeStderr(child);
    const handshake = await this.awaitHandshake(child);
    this.handshake = handshake;

    this.options.logger.info(
      { pid: child.pid, port: handshake.port, profile: this.options.profile },
      'Sidecar ready',
    );
    return handshake;
  }

  private pipeStderr(child: ChildProcess): void {
    if (child.stderr === null) {
      return;
    }
    const reader = createInterface({ input: child.stderr });
    reader.on('line', (line) => logSidecarLine(this.options.logger, line));
  }

  private awaitHandshake(child: ChildProcess): Promise<SidecarHandshake> {
    return new Promise<SidecarHandshake>((resolve, reject) => {
      if (child.stdout === null) {
        reject(new SidecarStartupError('Sidecar has no stdout'));
        return;
      }

      const reader = createInterface({ input: child.stdout });
      const timer = setTimeout(() => {
        finish(
          new SidecarStartupError(
            `Sidecar did not report a port within ${HANDSHAKE_TIMEOUT_MS} ms`,
          ),
        );
      }, HANDSHAKE_TIMEOUT_MS);

      const finish = (error: Error | null, value?: SidecarHandshake): void => {
        clearTimeout(timer);
        reader.close();
        child.off('exit', onExit);
        if (error !== null) {
          child.kill('SIGTERM');
          reject(error);
        } else if (value !== undefined) {
          resolve(value);
        }
      };

      const onExit = (code: number | null): void => {
        finish(new SidecarStartupError(`Sidecar exited during startup with code ${code}`));
      };

      child.once('exit', onExit);

      reader.on('line', (line) => {
        const parsed = parseHandshake(line);
        if (parsed !== null) {
          finish(null, parsed);
        }
      });
    });
  }

  /** Ask politely, then insist — a stuck model load will not answer SIGTERM. */
  async stop(graceMs = 10_000): Promise<void> {
    const child = this.child;
    if (child === null || this.exited) {
      return;
    }
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!exited) {
      this.options.logger.warn({ pid: child.pid }, 'Sidecar ignored SIGTERM; killing');
      child.kill('SIGKILL');
    }
    this.child = null;
    this.handshake = null;
  }
}

/**
 * Parse the handshake line, ignoring anything else on stdout.
 *
 * Exported for testing: a stray print from a dependency must not be mistaken for the
 * handshake, and must not stall startup either.
 */
export function parseHandshake(line: string): SidecarHandshake | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.event !== 'listening' || typeof record.port !== 'number') {
      return null;
    }
    return {
      port: record.port,
      protocolVersion: typeof record.protocolVersion === 'number' ? record.protocolVersion : 0,
    };
  } catch {
    return null;
  }
}
