// SPDX-License-Identifier: AGPL-3.0-or-later
import { destination, pino, type Logger } from 'pino';
import type { RotatingLogFile } from './log-file';

export type { Logger };

/**
 * Structured logging.
 *
 * Redaction is not decoration here: pipeline options carry filesystem paths, and job records
 * carry document filenames, both of which are user PII in a product handling scanned mail
 * and invoices. The sidecar token would grant local file access to anyone reading a log.
 */
const REDACTED_PATHS = [
  'authToken',
  'token',
  '*.authToken',
  '*.token',
  'headers["x-impressive-ocr-token"]',
  'req.headers["x-impressive-ocr-token"]',
  'req.headers.authorization',
];

export interface LoggerOptions {
  level: string;
  /** Kept for call-site clarity; both modes emit JSON — pipe through `pino-pretty` in dev. */
  pretty: boolean;
  /**
   * Also write to a rotating file the UI can read back.
   *
   * Omitted in tests, and in any context where the console is the only consumer.
   */
  file?: RotatingLogFile | undefined;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    },
    /**
     * A direct destination, deliberately **not** a pino `transport`.
     *
     * Transports run in a worker thread that loads `pino/lib/worker.js` from disk by path.
     * Inside the bundled Electron main process that file does not exist, so the worker dies
     * on startup and every subsequent `logger.info` throws "the worker has exited" — which
     * took down logging *and* the calls around it.
     *
     * fd 2 rather than 1: stdout is reserved for the headless mode's own handshake output.
     *
     * `sync: true` deliberately. An async destination buffers, and on a hard crash those
     * buffered lines are lost along with Node's own fatal-error report — which is the one
     * moment the log actually matters. This app writes a handful of lines per document, so
     * the throughput an async destination buys is worth nothing against that.
     */
    options.file === undefined ? consoleDestination() : teeTo(options.file),
  );
}

function consoleDestination(): ReturnType<typeof destination> {
  return destination({ dest: 2, sync: true });
}

/**
 * Write every record to the console *and* the log file.
 *
 * The console keeps working for anyone watching a terminal or a service manager; the file is
 * what the in-app log viewer reads. Pino writes one complete line per call, so splitting is a
 * matter of forwarding the same string twice.
 */
function teeTo(file: RotatingLogFile): { write(line: string): void } {
  const console_ = consoleDestination();
  return {
    write(line: string): void {
      console_.write(line);
      file.write(line);
    },
  };
}

/**
 * Forward a sidecar's stderr into our logger.
 *
 * The sidecar already emits one JSON object per line, so a parsed line becomes a real
 * structured record; anything unparseable (a Python traceback, a CUDA warning) is still
 * worth keeping verbatim rather than dropping.
 */
export function logSidecarLine(logger: Logger, line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const message = typeof record.msg === 'string' ? record.msg : 'sidecar';
      const level = typeof record.level === 'string' ? record.level : 'info';
      logger[normalizeLevel(level)]({ sidecar: record }, message);
      return;
    }
  } catch {
    // Not JSON — fall through and keep the raw line.
  }
  logger.info({ sidecarRaw: trimmed }, 'sidecar');
}

function normalizeLevel(level: string): 'debug' | 'info' | 'warn' | 'error' {
  switch (level) {
    case 'debug':
    case 'trace':
      return 'debug';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'error':
    case 'critical':
      return 'error';
    default:
      return 'info';
  }
}
