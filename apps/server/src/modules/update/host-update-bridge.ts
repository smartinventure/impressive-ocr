// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_UPDATE_MARKER_FILE,
  UPDATE_REQUEST_FILE,
  type HostUpdateState,
} from '@impressive-ocr/shared';
import type { Logger } from '../../infra/logger';

/**
 * The container's side of the update handshake: two files in a bind-mounted directory.
 *
 * This is the entire mechanism by which a containerised installation gets updated, and its
 * value is in what it does *not* do. It does not talk to Docker, it does not hold the Docker
 * socket, and it does not pass the host anything the host will interpret. It creates an empty
 * file. The host script reacts to that file existing and runs one hard-coded command.
 *
 * Handing the container `/var/run/docker.sock` instead would be far less code and is the
 * usual answer to "let the app update itself". It is also root-equivalent access to the host:
 * anything that can talk to that socket can start a privileged container with the host's
 * filesystem mounted. For a service whose whole job is to open untrusted documents from a
 * watched folder, that is not a trade worth making for a convenience button.
 *
 * Both file names are constants in `@impressive-ocr/shared` because the installer writes the
 * host half, and a rename on one side that missed the other would leave the button visible
 * and inert.
 */

export interface HostUpdateBridgeOptions {
  /**
   * The bind-mounted control directory, or null when there is none.
   *
   * Null on the desktop app and on a container someone started by hand — both report
   * `unavailable`, and the UI offers the manual command.
   */
  controlDir: string | null;
  logger: Logger;
}

export class HostUpdateBridge {
  private readonly controlDir: string | null;
  private readonly logger: Logger;

  constructor(options: HostUpdateBridgeOptions) {
    this.controlDir = options.controlDir;
    this.logger = options.logger;
  }

  /**
   * Whether a host updater is installed, and whether it has already been asked.
   *
   * Read from disk on every call rather than cached: the installer can be run against a
   * container that is already up, and the host script deletes the request file when it acts.
   * Both are cheap `existsSync` calls on a directory holding at most two empty files.
   */
  state(): HostUpdateState {
    if (this.controlDir === null) return 'unavailable';
    if (!existsSync(join(this.controlDir, HOST_UPDATE_MARKER_FILE))) return 'unavailable';
    if (existsSync(join(this.controlDir, UPDATE_REQUEST_FILE))) return 'requested';
    return 'ready';
  }

  /**
   * Ask the host to update, by creating the request file.
   *
   * Returns false when there is no host updater listening — the caller turns that into a 409
   * rather than reporting a scheduled update that will never happen.
   *
   * The file's *contents* are deliberately inert. A timestamp is written because an operator
   * finding a stale request wants to know how long it has been waiting, but the host script
   * never opens it: it acts on presence alone. Nothing the container writes can change what
   * the host runs.
   */
  requestUpdate(): boolean {
    if (this.controlDir === null) return false;
    if (!existsSync(join(this.controlDir, HOST_UPDATE_MARKER_FILE))) return false;

    const requestFile = join(this.controlDir, UPDATE_REQUEST_FILE);
    try {
      // The directory is bind-mounted and therefore already there in every supported setup;
      // created anyway so a hand-rolled compose file that mounted a parent still works.
      mkdirSync(this.controlDir, { recursive: true });
      writeFileSync(requestFile, `${new Date().toISOString()}\n`, { encoding: 'utf8' });
      this.logger.info({ requestFile }, 'Host update requested');
      return true;
    } catch (error) {
      // The usual cause is a bind mount owned by root while the container runs as uid 10001.
      // Logged with the path, because that is the one detail that makes it fixable.
      this.logger.error({ err: error, requestFile }, 'Could not write the update request');
      return false;
    }
  }
}
