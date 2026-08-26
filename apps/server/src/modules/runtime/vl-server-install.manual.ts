// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Manual check for the inference-engine installer. Not part of `pnpm test`.
 *
 * Downloads ~1.9 GB and quantises it, which is the whole point: every piece is unit-tested
 * separately, but only running it end to end proves the release URLs resolve, the archives
 * unpack where the pool looks, and the quantiser accepts what was downloaded.
 *
 *   node node_modules/.pnpm/tsx@*\/node_modules/tsx/dist/cli.mjs \
 *     apps/server/src/modules/runtime/vl-server-install.manual.ts
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../infra/logger';
import { vlServerPaths } from '../../infra/paths';
import { isInstalled } from '../ocr/vl-server-availability';
import { QUANTISATION, selectVlServerBuild } from '../ocr/vl-server-index';
import { probeHardware } from './gpu-probe';
import { installVlServer } from './vl-server-installer';

const logger = createLogger({ level: 'info', pretty: false });

const root = await mkdtemp(join(tmpdir(), 'impressive-ocr-vl-install-'));
const hardware = await probeHardware();
const build = selectVlServerBuild(hardware);

process.stdout.write(`\n  target   ${root}\n  build    ${build.description}\n\n`);

const started = Date.now();
try {
  await installVlServer({
    vlServerDir: root,
    hardware,
    onMessage: (message) => process.stdout.write(`  ${message}\n`),
    logger,
  });

  const paths = vlServerPaths(root, QUANTISATION);
  if (!isInstalled(paths)) {
    throw new Error('Installer finished but the result does not look installed');
  }

  const model = await stat(paths.model);
  const projector = await stat(paths.projector);
  process.stdout.write(
    `\n  installed in ${((Date.now() - started) / 1000).toFixed(0)}s\n` +
      `  model      ${(model.size / 1024 ** 2).toFixed(0)} MB (${QUANTISATION})\n` +
      `  projector  ${(projector.size / 1024 ** 2).toFixed(0)} MB\n\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
