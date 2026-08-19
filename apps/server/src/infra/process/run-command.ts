// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Child-process helper for the runtime bootstrap.
 *
 * `pip install paddlepaddle-gpu` downloads gigabytes and runs for minutes. That rules out
 * `execFile`-style buffering — the user needs to see it progressing, and the whole thing
 * must be cancellable when they close the wizard.
 */

export interface RunCommandOptions {
  command: string;
  args: readonly string[];
  // Optionals spell out `| undefined` because the workspace runs with
  // exactOptionalPropertyTypes, which otherwise rejects every caller that passes through an
  // absent AbortSignal.
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  /** Called for each complete stdout/stderr line as it arrives. */
  onLine?: ((line: string, stream: 'stdout' | 'stderr') => void) | undefined;
  timeoutMs?: number | undefined;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class CommandFailedError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    // Only the tail: pip failures end in hundreds of lines of resolver output, and the
    // actionable message is always at the bottom.
    super(`${command} exited with code ${exitCode}: ${tail(stderr, 500)}`);
    this.name = 'CommandFailedError';
  }
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
    shell: false, // Never a shell: arguments here include user-influenced paths.
  });

  const stdout = collect(child, 'stdout', options.onLine);
  const stderr = collect(child, 'stderr', options.onLine);

  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);

  const onAbort = (): void => {
    child.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? -1));
    });

    if (options.signal?.aborted === true) {
      throw new DOMException('Command aborted', 'AbortError');
    }
    if (exitCode !== 0) {
      throw new CommandFailedError(options.command, exitCode, stderr.text());
    }
    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener('abort', onAbort);
  }
}

interface Collected {
  text: () => string;
}

/**
 * Buffer a stream while emitting complete lines.
 *
 * Chunk boundaries fall mid-line, so a naive per-chunk callback would split messages —
 * which for the sidecar's NDJSON handshake would mean unparseable JSON.
 */
function collect(
  child: ChildProcessWithoutNullStreams,
  stream: 'stdout' | 'stderr',
  onLine: RunCommandOptions['onLine'],
): Collected {
  const chunks: string[] = [];
  let pending = '';

  child[stream].setEncoding('utf8');
  child[stream].on('data', (chunk: string) => {
    chunks.push(chunk);
    if (onLine === undefined) {
      return;
    }
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line, stream);
    }
  });
  child[stream].on('end', () => {
    if (pending.length > 0 && onLine !== undefined) {
      onLine(pending, stream);
      pending = '';
    }
  });

  return { text: () => chunks.join('') };
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : `...${value.slice(-limit)}`;
}
