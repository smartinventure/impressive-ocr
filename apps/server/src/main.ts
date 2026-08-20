// SPDX-License-Identifier: AGPL-3.0-or-later
import { createApp } from './app';

/**
 * Headless server entry point — "Impressive OCR Server".
 *
 * The Electron app calls `createApp()` directly in its main process; this file exists so the
 * same backend runs on a box with no desktop, as a Windows Service, a systemd unit, or just
 * `node dist/main.js` in a terminal.
 */

async function main(): Promise<void> {
  const app = await createApp({
    dataDir: process.env.IMPRESSIVE_OCR_DATA_DIR,
    uvBinary: process.env.IMPRESSIVE_OCR_UV_BINARY,
    port: parsePort(process.env.IMPRESSIVE_OCR_PORT),
  });

  const url = await app.listen();
  // Deliberately on stdout rather than through the logger: a service wrapper or a user
  // starting this in a terminal needs to see the URL, whatever the configured log level is.
  process.stdout.write(`\nImpressive OCR is running at ${url}\n\n`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second Ctrl-C during a long drain should not start a second teardown.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.logger.info({ signal }, 'Signal received; shutting down');

    void app
      .shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.logger.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // An unhandled rejection here means a background task died. Log it loudly rather than
  // letting Node terminate with no explanation of which subsystem failed.
  process.on('unhandledRejection', (reason) => {
    app.logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

/** Service managers and container runtimes conventionally pass the port through the environment. */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`IMPRESSIVE_OCR_PORT must be a number between 1024 and 65535, got "${value}"`);
  }
  return port;
}

main().catch((error: unknown) => {
  // A bare message, not a stack: the common failures here (port taken, bad env var) are
  // things the person starting the service can fix, and a stack buries the one useful line.
  process.stderr.write(
    `Failed to start Impressive OCR: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
