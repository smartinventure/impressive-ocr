// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import type { HardwareCapabilities, RuntimeStep } from '@impressive-ocr/shared';
import { ensureDirectory, exists } from '../../infra/fs/file-ops';
import type { Logger } from '../../infra/logger';
import { venvPython } from '../../infra/paths';
import { runCommand } from '../../infra/process/run-command';
import { toUserMessage } from './progress-output';
import { assertEnoughSpaceForInstall } from './disk-space';
import { repairModelCache } from './model-cache';
import { pipInstallArgs, selectWheel, type WheelSelection } from './wheel-index';

/**
 * Installs the Python side on the user's machine.
 *
 * The app ships without Python or PaddleOCR: the GPU wheel alone is multiple gigabytes and
 * we would have to ship a separate CPU and GPU installer per platform. Instead a bundled
 * `uv` binary fetches a pinned Python, builds a venv, and installs the wheel chosen *after*
 * probing the hardware.
 *
 * Every step streams progress, because a silent multi-gigabyte download is indistinguishable
 * from a hung application.
 */

/** Pinned so an upstream Python release cannot change behaviour under an existing install. */
export const PYTHON_VERSION = '3.12';

/** Pinned for the same reason; upgraded deliberately, with a runtime-version bump. */
export const PADDLEOCR_REQUIREMENT = 'paddleocr[doc-parser]';

export interface InstallProgress {
  step: RuntimeStep;
  percent: number;
  message: string;
}

export interface RuntimeInstallerOptions {
  uvBinary: string;
  venvDir: string;
  modelCacheDir: string;
  sidecarProjectDir: string;
  logger: Logger;
}

export interface InstallRequest {
  hardware: HardwareCapabilities;
  onProgress: (progress: InstallProgress) => void;
  signal?: AbortSignal;
}

/** What the interpreter reports about itself once everything is installed. */
export interface RuntimeVersions {
  python: string | null;
  paddle: string | null;
  paddleocr: string | null;
}

export interface InstallResult {
  pythonPath: string;
  selection: WheelSelection;
  versions: RuntimeVersions;
}

/**
 * Weight of each step in the overall progress bar.
 *
 * Wall-clock, not step count: installing Paddle is most of the wait, so giving all steps
 * equal weight would park the bar at 40% for several minutes.
 */
const STEP_WEIGHTS: Record<RuntimeStep, number> = {
  'probe-hardware': 2,
  'install-python': 8,
  'create-venv': 3,
  'install-paddle': 45,
  'install-paddleocr': 22,
  'download-models': 15,
  verify: 5,
};

const STEP_ORDER: readonly RuntimeStep[] = [
  'probe-hardware',
  'install-python',
  'create-venv',
  'install-paddle',
  'install-paddleocr',
  'download-models',
  'verify',
];

/** Percentage already completed once `step` finishes. */
export function progressAfter(step: RuntimeStep): number {
  let total = 0;
  for (const candidate of STEP_ORDER) {
    total += STEP_WEIGHTS[candidate];
    if (candidate === step) {
      break;
    }
  }
  return total;
}

/** Percentage at which `step` begins. */
export function progressBefore(step: RuntimeStep): number {
  return progressAfter(step) - STEP_WEIGHTS[step];
}

export class RuntimeInstaller {
  constructor(private readonly options: RuntimeInstallerOptions) {}

  async install(request: InstallRequest): Promise<InstallResult> {
    const { hardware, onProgress, signal } = request;
    const selection = selectWheel(hardware);
    const python = venvPython(this.options.venvDir);

    this.options.logger.info(
      { flavor: selection.flavor, gpu: hardware.gpu?.name ?? null },
      'Starting Python runtime installation',
    );

    // Checked before anything is downloaded. A full disk otherwise surfaces as a failure deep
    // inside pip, or a half-written venv, with nothing pointing at the actual cause.
    await ensureDirectory(this.options.venvDir);
    await assertEnoughSpaceForInstall(this.options.venvDir);

    await this.step('install-python', onProgress, `Downloading Python ${PYTHON_VERSION}`, () =>
      this.run(['python', 'install', PYTHON_VERSION], onProgress, 'install-python', signal),
    );

    await this.step('create-venv', onProgress, 'Creating the virtual environment', async () => {
      await ensureDirectory(this.options.venvDir);
      await this.run(
        ['venv', '--python', PYTHON_VERSION, this.options.venvDir],
        onProgress,
        'create-venv',
        signal,
      );
    });

    await this.step('install-paddle', onProgress, `Installing ${selection.description}`, () =>
      this.run(
        [...pipInstallArgs(selection), '--python', python],
        onProgress,
        'install-paddle',
        signal,
      ),
    );

    await this.step('install-paddleocr', onProgress, 'Installing PaddleOCR', () =>
      this.run(
        [
          'pip',
          'install',
          '--upgrade',
          PADDLEOCR_REQUIREMENT,
          this.options.sidecarProjectDir,
          '--python',
          python,
        ],
        onProgress,
        'install-paddleocr',
        signal,
      ),
    );

    await this.step('download-models', onProgress, 'Downloading OCR models', async () => {
      // A previous attempt may have been interrupted mid-download. PaddleOCR would then treat
      // the partial weights as a valid cache and fail with an error naming neither the model
      // nor the download, forever.
      // The redirected scratch directory has to exist before Python looks for it.
      await ensureDirectory(join(this.options.modelCacheDir, 'tmp'));
      const repair = await repairModelCache(this.options.modelCacheDir, this.options.logger);
      if (repair.removed.length > 0) {
        onProgress({
          step: 'download-models',
          percent: progressBefore('download-models'),
          message: `Re-downloading ${repair.removed.length} incomplete model(s)`,
        });
      }
      await this.warmModels(python, onProgress, signal);
    });

    const versions = await this.step('verify', onProgress, 'Verifying the installation', () =>
      this.verify(python, signal),
    );

    onProgress({ step: 'verify', percent: 100, message: 'Runtime ready' });
    return { pythonPath: python, selection, versions };
  }

  /** True when a usable interpreter already exists, so setup can be skipped. */
  async isInstalled(): Promise<boolean> {
    return exists(venvPython(this.options.venvDir));
  }

  /**
   * Read the versions of an interpreter that is already installed.
   *
   * Needed because installs that predate version reporting stored nulls, and the System page
   * then shows a dash forever — the alternative being to ask the user to reinstall several
   * gigabytes to populate three strings.
   *
   * Failure is not an error: this is display detail, and an interpreter that cannot answer
   * has bigger problems that `isInstalled` and the first job will surface properly.
   */
  async readVersions(signal?: AbortSignal): Promise<RuntimeVersions> {
    try {
      return await this.verify(venvPython(this.options.venvDir), signal);
    } catch {
      return { python: null, paddle: null, paddleocr: null };
    }
  }

  /**
   * Keep everything `uv` downloads inside the app's own runtime directory.
   *
   * By default uv caches to `%LOCALAPPDATA%\uv` and installs Pythons there too — always on
   * the system drive, whatever the user chose for their data. That is how an install onto a
   * roomy D: still failed with "not enough space on the disk": the venv went to D: while the
   * ~1 GB of staged wheels went to a full C:.
   *
   * Co-locating them also means the space check measures the drive that actually matters, and
   * an uninstall reclaims every byte instead of orphaning a cache the user never knew about.
   */
  private uvEnvironment(): NodeJS.ProcessEnv {
    const runtimeDir = join(this.options.venvDir, '..');
    return {
      UV_CACHE_DIR: join(runtimeDir, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(runtimeDir, 'python'),
    };
  }

  /**
   * Environment for the Python steps, pinning every model cache into our runtime directory.
   *
   * PaddleOCR does not fetch models itself — it delegates to `huggingface_hub`, which caches
   * to `~/.cache/huggingface`, and to ModelScope, which caches to `~/.cache/modelscope`. Both
   * land on the **system drive** regardless of where the user put their data.
   *
   * That is not a tidiness point. It is what made this fail on a machine whose C: was full
   * while D: had 100 GB: PaddleX reported "No valid PaddlePaddle model found", because every
   * download had been truncated into a `.incomplete` file on a disk with no room — an error
   * that mentions neither downloading nor disk space.
   */
  private modelEnvironment(): NodeJS.ProcessEnv {
    const cache = this.options.modelCacheDir;
    const scratch = join(cache, 'tmp');
    return {
      PADDLE_PDX_CACHE_HOME: cache,
      PADDLE_PDX_MODEL_SOURCE: 'huggingface',
      HF_HOME: join(cache, 'huggingface'),
      HF_HUB_CACHE: join(cache, 'huggingface', 'hub'),
      MODELSCOPE_CACHE: join(cache, 'modelscope'),
      XDG_CACHE_HOME: join(cache, 'xdg'),
      /**
       * The scratch directory too, and this is the one that is easy to miss.
       *
       * Both downloaders write to a `tempfile` first and move the finished file into the
       * cache. Redirecting only the caches therefore fixes nothing: the *download* still
       * happens on the system drive. On a full C: that produced `[Errno 28] No space left on
       * device` from inside HuggingFace, then a silent fallback to ModelScope, which failed
       * the same way — and PaddleOCR finally reported "No valid PaddlePaddle model found".
       */
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    };
  }

  private async step<TResult>(
    step: RuntimeStep,
    onProgress: InstallRequest['onProgress'],
    message: string,
    work: () => Promise<TResult>,
  ): Promise<TResult> {
    onProgress({ step, percent: progressBefore(step), message });
    const result = await work();
    onProgress({ step, percent: progressAfter(step), message: `${message} — done` });
    return result;
  }

  private async run(
    args: readonly string[],
    onProgress: InstallRequest['onProgress'],
    step: RuntimeStep,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const floor = progressBefore(step);
    const ceiling = progressAfter(step);
    await runCommand({
      command: this.options.uvBinary,
      args,
      signal,
      env: { ...process.env, ...this.uvEnvironment() },
      onLine: (line) => {
        // The raw line still goes to the log, where a progress bar is harmless and the
        // detail matters when an install fails.
        this.options.logger.debug({ step, line: line.trim() }, 'runtime installer');

        const message = toUserMessage(line);
        if (message === null) {
          return;
        }
        // uv reports progress per package, not as a percentage, so the bar advances
        // toward — never past — the step's ceiling as lines arrive.
        onProgress({ step, percent: Math.min(ceiling - 1, floor + 1), message });
      },
    });
  }

  /**
   * Import the pipelines once so PaddleOCR downloads its weights now rather than during the
   * user's first job — which would otherwise look like a mysteriously slow first document.
   */
  private async warmModels(
    python: string,
    onProgress: InstallRequest['onProgress'],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await runCommand({
      command: python,
      args: ['-c', WARM_MODELS_SCRIPT],
      signal,
      env: { ...process.env, ...this.modelEnvironment() },
      onLine: (line) => {
        // Hugging Face draws a tqdm bar per model file; unfiltered they were the "weird
        // characters" users saw in the status line.
        const message = toUserMessage(line);
        if (message !== null) {
          onProgress({
            step: 'download-models',
            percent: progressBefore('download-models') + 1,
            message,
          });
        }
      },
    });
  }

  /**
   * Confirm the runtime imports, and read back what was actually installed.
   *
   * The versions come from the interpreter rather than from what we asked for: a resolver
   * can legitimately pick a different build, and reporting our intent instead of the result
   * would make the System page confidently wrong.
   */
  private async verify(python: string, signal: AbortSignal | undefined): Promise<RuntimeVersions> {
    let versions: RuntimeVersions = { python: null, paddle: null, paddleocr: null };

    await runCommand({
      command: python,
      args: ['-c', VERIFY_SCRIPT],
      signal,
      timeoutMs: 120_000,
      onLine: (line) => {
        const parsed = parseVersions(line);
        if (parsed !== null) {
          versions = parsed;
        }
      },
    });

    return versions;
  }
}

/**
 * Warm the engine through the sidecar's own registry, not `PPStructureV3` directly.
 *
 * Constructing that pipeline bare downloads *every* sub-model it can use — formula, chart,
 * seal and table-cell detection — because PaddleOCR resolves and fetches them in its
 * constructor from the toggles it was given, and bare means "all of them". Hundreds of
 * megabytes, for features the default pipeline has switched off.
 *
 * Going through `create_engine` warms exactly what a job will load, and inherits the oneDNN
 * handling rather than duplicating it here.
 */
const WARM_MODELS_SCRIPT = [
  'from impressive_ocr_sidecar.core.protocol import EngineOptions',
  'from impressive_ocr_sidecar.engines.registry import create_engine',
  'print("Preparing OCR models", flush=True)',
  'options = EngineOptions()',
  'engine = create_engine("fast", "cpu", options.modules)',
  'engine.load()',
  'print("Models ready", flush=True)',
].join('\n');

const VERSION_PREFIX = 'IMPRESSIVE_OCR_VERSIONS ';

/**
 * Confirm every import resolves, and report what was actually installed.
 *
 * One JSON line behind a distinctive prefix, so parsing it cannot collide with anything else
 * a dependency decides to print.
 */
const VERIFY_SCRIPT = [
  'import json, sys',
  'import paddle, paddleocr, impressive_ocr_sidecar',
  `print("${VERSION_PREFIX}" + json.dumps({`,
  '    "python": sys.version.split()[0],',
  '    "paddle": paddle.__version__,',
  '    "paddleocr": paddleocr.__version__,',
  '}), flush=True)',
].join('\n');

/** Pull the version payload out of a stdout line, or null when this is not that line. */
export function parseVersions(line: string): RuntimeVersions | null {
  const index = line.indexOf(VERSION_PREFIX);
  if (index === -1) return null;

  try {
    const payload: unknown = JSON.parse(line.slice(index + VERSION_PREFIX.length).trim());
    if (typeof payload !== 'object' || payload === null) return null;

    const record = payload as Record<string, unknown>;
    return {
      python: asVersion(record.python),
      paddle: asVersion(record.paddle),
      paddleocr: asVersion(record.paddleocr),
    };
  } catch {
    // A truncated line is not worth failing an otherwise successful install over.
    return null;
  }
}

function asVersion(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
