// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { createSidecarLineForwarder, type Logger } from '../../infra/logger';

/**
 * Owns one `llama-server`: start it, wait until it can actually answer, watch it, stop it.
 *
 * Deliberately shaped like `sidecar-process.ts`, because it is the same job — a child process
 * the pool has to supervise. It differs in three ways, each forced by llama.cpp rather than
 * chosen:
 *
 * 1. **The port is ours to pick.** Our Python sidecar binds port 0 and prints what it got;
 *    `llama-server` needs the number up front, so one is reserved before spawning.
 * 2. **Readiness is polled.** There is no handshake line, so `/health` is asked instead.
 * 3. **It needs waking.** Startup loads the weights but never runs an image through the
 *    vision encoder, so the first real request pays 14-17 s against a 2 s steady state.
 *    `warmUp` spends that once, here, instead of charging it to the user's first document.
 */

const READY_TIMEOUT_MS = 240_000;
const READY_POLL_MS = 500;
const WARM_UP_TIMEOUT_MS = 120_000;

/** Context per slot: one region's image tokens plus everything it writes back. */
const TOKENS_PER_SLOT = 4096;

/**
 * A 1x1 PNG. Small enough to cost nothing, real enough to force the vision encoder to
 * compile its kernels, which is the whole point of the warm-up.
 */
const WARM_UP_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export interface VlServerProcessOptions {
  /** The `llama-server` executable inside the runtime directory. */
  executablePath: string;
  modelPath: string;
  projectorPath: string;
  /** Layout regions in flight at once. Must equal PaddleOCR's `vl_rec_max_concurrency`. */
  concurrency: number;
  /** 0 keeps every layer on the CPU, which is a supported configuration, not a failure. */
  gpuLayers: number;
  logger: Logger;
}

export class VlServerStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlServerStartupError';
  }
}

export class VlServerProcess {
  private child: ChildProcess | null = null;
  private exited = false;
  private port: number | null = null;

  constructor(private readonly options: VlServerProcessOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Base URL including the `/v1` suffix PaddleOCR expects, or null before `start()`. */
  get baseUrl(): string | null {
    return this.port === null ? null : `http://127.0.0.1:${this.port}/v1`;
  }

  /**
   * Start the server and resolve only once it can answer a real request.
   *
   * Rejects rather than resolving on a failed start, so the pool can fall back to the native
   * backend instead of handing out a URL that will fail every page.
   */
  async start(): Promise<string> {
    if (this.child !== null) {
      throw new VlServerStartupError('Inference server already started');
    }

    const port = await reserveEphemeralPort();
    const child = spawn(this.options.executablePath, this.buildArguments(port), {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.exited = false;
    this.port = port;

    child.once('exit', (code, signal) => {
      this.exited = true;
      this.options.logger.warn({ pid: child.pid, code, signal }, 'Inference server exited');
    });
    this.pipeOutput(child);

    try {
      await this.awaitHealth(port);
      await this.warmUp(port);
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.options.logger.info(
      { pid: child.pid, port, concurrency: this.options.concurrency },
      'Inference server ready',
    );
    return `http://127.0.0.1:${port}/v1`;
  }

  /**
   * `--parallel` and PaddleOCR's `vl_rec_max_concurrency` are the same number on purpose:
   * whichever is smaller becomes the real limit, and the other half of the slots idle.
   *
   * The context is sized per slot rather than absolutely, because dividing a fixed budget by
   * the slot count is what made 16 and 24 slots measure *slower* than 8.
   *
   * 4096 rather than 2048, and the difference is not academic. A slot holds one layout
   * region's image tokens *plus* everything it writes back, so a dense full-width region —
   * a page of photo credits, a wall of terms and conditions — overruns 2048 and the answer
   * is simply cut off mid-sentence. That page measured 37% word accuracy against its own
   * text layer, having silently dropped 555 words of 901; at 4096 it scores 94%. It costs
   * nothing worth counting: peak VRAM moved by about 150 MB.
   */
  private buildArguments(port: number): string[] {
    return [
      '--model',
      this.options.modelPath,
      '--mmproj',
      this.options.projectorPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--n-gpu-layers',
      String(this.options.gpuLayers),
      '--parallel',
      String(this.options.concurrency),
      '--ctx-size',
      String(this.options.concurrency * TOKENS_PER_SLOT),
      // Nothing here serves a browser, and the bundled UI is dead weight in our process.
      '--no-webui',
    ];
  }

  private pipeOutput(child: ChildProcess): void {
    // One forwarder for both streams of this process, because a traceback written to stderr
    // is one sequence however the two are interleaved — and a forwarder each would let stdout
    // reset the flag mid-traceback.
    const forward = createSidecarLineForwarder(this.options.logger);
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) {
        continue;
      }
      const reader = createInterface({ input: stream });
      reader.on('line', forward);
    }
  }

  /**
   * Poll `/health` until it answers, the process dies, or we give up.
   *
   * The timeout is generous because this covers reading ~1.2 GB of weights off disk, which
   * on a cold cache and a slow disk is genuinely minutes.
   */
  private async awaitHealth(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.exited) {
        throw new VlServerStartupError('Inference server exited during startup');
      }
      if (await isHealthy(port)) {
        return;
      }
      await delay(READY_POLL_MS);
    }
    throw new VlServerStartupError(
      `Inference server was not ready within ${READY_TIMEOUT_MS} ms`,
    );
  }

  /**
   * Send one tiny image so the vision encoder is compiled and resident.
   *
   * A failure here is logged, not thrown: the server is demonstrably healthy, and refusing to
   * use it because a warm-up request was unhappy would cost the user the whole speed-up to
   * save them a slow first page.
   */
  private async warmUp(port: number): Promise<void> {
    const started = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'ok' },
                { type: 'image_url', image_url: { url: WARM_UP_IMAGE } },
              ],
            },
          ],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(WARM_UP_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      await response.arrayBuffer();
      this.options.logger.info({ ms: Date.now() - started }, 'Inference server warmed up');
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        'Inference server warm-up failed; the first document will be slower',
      );
    }
  }

  /** Ask politely, then insist — a server mid-load will not answer SIGTERM. */
  async stop(graceMs = 10_000): Promise<void> {
    const child = this.child;
    this.child = null;
    this.port = null;
    if (child === null || this.exited) {
      return;
    }

    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!exited) {
      this.options.logger.warn({ pid: child.pid }, 'Inference server ignored SIGTERM; killing');
      child.kill('SIGKILL');
    }
  }
}

/**
 * Reserve a free port by binding one and letting it go.
 *
 * Racy in principle — something could take it in the gap — but `llama-server` has no way to
 * report a port it chose itself, so the alternative is a hard-coded number that collides with
 * whatever else the user is running. A lost race surfaces as a startup failure and falls back.
 */
export async function reserveEphemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new VlServerStartupError('Could not reserve a port for the inference server'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
