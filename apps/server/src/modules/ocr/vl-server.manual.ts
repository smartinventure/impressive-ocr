// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Manual end-to-end check for the batching inference backend. Not part of `pnpm test`.
 *
 * Deliberately outside the `*.test.ts` glob: it needs a real installed runtime, a real
 * `llama-server` and a couple of minutes, none of which belong in a suite that has to run on
 * every machine. It exists because the unit tests cannot answer the only question that
 * matters here — whether a page actually comes back in ~2 s instead of ~56 s.
 *
 *   pnpm --filter @impressive-ocr/server exec vitest run \
 *     --include "src/modules/ocr/vl-server.manual.ts"
 */
import { engineOptionsSchema } from '@impressive-ocr/shared';
import { resolveAppPaths, venvPython, vlServerPaths } from '../../infra/paths';
import { createLogger } from '../../infra/logger';
import { SidecarClient } from './sidecar-client';
import { SidecarProcess } from './sidecar-process';
import { isInstalled } from './vl-server-availability';
import { LLAMA_CPP_BACKEND, QUANTISATION } from './vl-server-index';
import { VlServerProcess } from './vl-server-process';

const paths = resolveAppPaths(process.env.IMPRESSIVE_OCR_DATA_DIR);
const logger = createLogger({ level: 'info', pretty: false });
const PAGE = 'D:\\_PROGRAMMING_SourceTree\\impressive-ocr\\_resources\\samples\\spiegel-page-1.pdf';

async function main(): Promise<void> {
  {
    const installed = vlServerPaths(paths.vlServerDir, QUANTISATION);
    if (!isInstalled(installed)) {
      throw new Error(`Inference server is not installed at ${paths.vlServerDir}`);
    }

    const server = new VlServerProcess({
      executablePath: installed.executable,
      modelPath: installed.model,
      projectorPath: installed.projector,
      concurrency: 8,
      gpuLayers: 99,
      logger,
    });
    const url = await server.start();

    const sidecar = new SidecarProcess({
      pythonPath: venvPython(paths.venvDir),
      profile: 'accurate',
      device: 'gpu',
      authToken: 'manual-check',
      modelCacheDir: paths.modelCacheDir,
      logLevel: 'error',
      cpuBudgetPercent: 75,
      vlServer: { backend: LLAMA_CPP_BACKEND, url, maxConcurrency: 8 },
      logger,
    });

    try {
      const handshake = await sidecar.start();
      const client = new SidecarClient({ port: handshake.port, authToken: 'manual-check' });

      // First document also loads the models; the number that matters is the second.
      const cold = await run(client);
      const warm = await run(client);

      process.stdout.write(
        `\n  cold ${cold.toFixed(2)}s | warm ${warm.toFixed(2)}s/page (native baseline 56.4s)\n\n`,
      );
      if (warm > 15) {
        throw new Error(`Expected a page in under 15s, took ${warm.toFixed(2)}s`);
      }
    } finally {
      await sidecar.stop();
      await server.stop();
    }
  }
}

async function run(client: SidecarClient): Promise<number> {
  const started = Date.now();
  let pages = 0;

  for await (const message of client.runJob({
    jobId: `manual-${started}`,
    sourcePath: PAGE,
    workDir: paths.workDir,
    outputStem: 'manual-check',
    profile: 'accurate',
    device: 'gpu',
    engine: engineOptionsSchema.parse({}),
    textLayerStrategy: 'always-ocr',
    formats: ['markdown'],
    txtEncoding: 'utf-8',
  })) {
    if (message.type === 'page') {
      pages += 1;
    }
    if (message.type === 'error') {
      throw new Error(`${message.code}: ${message.message}`);
    }
  }

  if (pages === 0) {
    throw new Error('No pages came back');
  }
  return (Date.now() - started) / 1000;
}

await main();
