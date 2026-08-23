// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpus } from 'node:os';
import {
  PREFLIGHT_BLOCKED_MESSAGE,
  type PreflightCheck,
  type PreflightReport,
} from '@impressive-ocr/shared';
import { exists } from '../../infra/fs/file-ops';
import {
  REQUIRED_INSTALL_BYTES,
  formatGib,
  measureNearestDiskSpace,
  type DiskSpace,
} from './disk-space';
import { detectCpuFeatures, type CpuFeatures } from './cpu-features';
import { describeCurrentPlatform, type PlatformReport } from './platform-support';
import { probeVcRuntime, VC_REDIST_DOWNLOAD_URL, type VcRuntimeReport } from './vc-runtime';

/**
 * Everything that must be true before a multi-gigabyte download is worth starting.
 *
 * The install already refuses to start without disk space. This generalises that idea: ask
 * every question whose answer is knowable in advance, and separate the answers into "one
 * download away" and "this machine will never run it".
 *
 * The separation is the point. A checker that only understood missing components would, on a
 * CPU without AVX, dutifully install the Visual C++ redistributable, report success, and then
 * fail three gigabytes later with `DLL load failed` — which is precisely the experience this
 * replaces.
 */

export interface PreflightInputs {
  platform: PlatformReport;
  cpuModel: string;
  /** `process.arch`; AVX is only a meaningful question on x86. */
  arch: string;
  features: CpuFeatures;
  vcRuntime: VcRuntimeReport;
  /** Whether the bundled `uv` binary is present, and where it was looked for. */
  installer: InstallerReport;
  /** Null when the filesystem cannot be measured, which must not block an install. */
  disk: DiskSpace | null;
  requiredBytes: number;
  now: Date;
}

export interface InstallerReport {
  present: boolean;
  path: string;
}

/** Where a developer gets the binary; a packaged build ships it. */
const FETCH_UV_COMMAND = 'node deploy/fetch-uv.mjs';

/**
 * Build the report from already-gathered facts.
 *
 * Pure and exported so every branch is testable without owning the hardware that produces it
 * — the same reason `parseGpuTable` is separate from `probeGpu`.
 */
export function buildPreflightReport(inputs: PreflightInputs): PreflightReport {
  const checks: PreflightCheck[] = [
    describePlatformCheck(inputs),
    ...describeAvxCheck(inputs),
    ...describeVcRuntimeCheck(inputs),
    describeInstallerCheck(inputs),
    describeDiskCheck(inputs),
  ];

  return {
    canInstall: !checks.some((check) => check.severity === 'blocked'),
    hasFixable: checks.some((check) => check.severity === 'fixable'),
    checks,
    checkedAt: inputs.now.toISOString(),
  };
}

export interface PreflightRequest {
  /** The filesystem whose free space matters — where the runtime and models will land. */
  dataDirectory: string;
  /** Path to the bundled `uv` binary. */
  uvBinary: string;
}

/** Gather the facts and build the report. */
export async function runPreflight(
  request: PreflightRequest,
  requiredBytes: number = REQUIRED_INSTALL_BYTES,
): Promise<PreflightReport> {
  const [features, vcRuntime, disk, uvPresent] = await Promise.all([
    detectCpuFeatures(),
    probeVcRuntime(),
    // Nearest existing ancestor: before the first install the venv directory is not there
    // yet, and measuring it directly reports "unmeasurable" on a perfectly healthy disk.
    measureNearestDiskSpace(request.dataDirectory),
    exists(request.uvBinary),
  ]);

  return buildPreflightReport({
    platform: describeCurrentPlatform(),
    cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
    arch: process.arch,
    features,
    vcRuntime,
    installer: { present: uvPresent, path: request.uvBinary },
    disk,
    requiredBytes,
    now: new Date(),
  });
}

function describePlatformCheck(inputs: PreflightInputs): PreflightCheck {
  if (inputs.platform.support === 'native') {
    return {
      id: 'platform',
      severity: 'ok',
      title: 'Operating system and architecture',
      detail: 'PaddlePaddle publishes a native build for this platform.',
      remedy: null,
    };
  }

  // Emulated counts as blocked, not as a warning. Under emulation PaddleOCR does not merely
  // run slowly: inference has been observed to kill the process with no traceback at all, and
  // every symptom of it reads as a bug in this application.
  return {
    id: 'platform',
    severity: 'blocked',
    title: 'Operating system and architecture',
    detail: inputs.platform.reason,
    remedy: null,
  };
}

/**
 * The AVX check, and the reason this whole module exists.
 *
 * Omitted entirely on non-x86, where the question is meaningless and the platform check has
 * already given the real answer.
 */
function describeAvxCheck(inputs: PreflightInputs): PreflightCheck[] {
  if (inputs.arch !== 'x64' && inputs.arch !== 'ia32') {
    return [];
  }

  if (inputs.features.avx === 'no') {
    return [
      {
        id: 'cpu-avx',
        severity: 'blocked',
        title: 'CPU instruction set',
        detail:
          `${inputs.cpuModel} does not support AVX, and every current PaddlePaddle build ` +
          'requires it. The engine would stop with an illegal-instruction fault while ' +
          'loading, before processing anything. No-AVX builds were discontinued after ' +
          'PaddlePaddle 2.4.2 (Python 3.8), which is far too old for this application. An ' +
          'x86-64 machine with AVX, or a Mac with Apple Silicon, is the supported ' +
          'configuration.',
        remedy: null,
      },
    ];
  }

  if (inputs.features.avx === 'unknown') {
    return [
      {
        id: 'cpu-avx',
        severity: 'ok',
        title: 'CPU instruction set',
        detail:
          'Could not determine whether this CPU supports AVX. The install will go ahead; ' +
          'an AVX-less CPU would fail when the engine first loads.',
        remedy: null,
      },
    ];
  }

  return [
    {
      id: 'cpu-avx',
      severity: 'ok',
      title: 'CPU instruction set',
      detail:
        inputs.features.avx2 === 'yes'
          ? `${inputs.cpuModel} supports AVX and AVX2.`
          : `${inputs.cpuModel} supports AVX.`,
      remedy: null,
    },
  ];
}

function describeVcRuntimeCheck(inputs: PreflightInputs): PreflightCheck[] {
  if (inputs.vcRuntime.status === 'not-applicable') {
    return [];
  }

  if (inputs.vcRuntime.status === 'present') {
    return [
      {
        id: 'vc-runtime',
        severity: 'ok',
        title: 'Microsoft Visual C++ runtime',
        detail: 'The Visual C++ runtime PaddlePaddle needs is installed.',
        remedy: null,
      },
    ];
  }

  return [
    {
      id: 'vc-runtime',
      severity: 'fixable',
      title: 'Microsoft Visual C++ runtime',
      detail:
        `Missing from System32: ${inputs.vcRuntime.missing.join(', ')}. PaddlePaddle's ` +
        'libraries link against these, and without them the engine fails to load with an ' +
        'error that names neither the file nor the cause.',
      remedy: {
        summary: 'Install the Microsoft Visual C++ 2015-2022 Redistributable (x64)',
        downloadUrl: VC_REDIST_DOWNLOAD_URL,
        steps: [
          'Download vc_redist.x64.exe from Microsoft using the link above.',
          'Run it and accept the elevation prompt.',
          'Restart Impressive OCR, then run this check again.',
        ],
      },
    },
  ];
}

/**
 * The bundled `uv` binary, which installs Python and the wheels.
 *
 * `vendor/uv/` is gitignored because it is a 44 MB binary, so a fresh clone genuinely does
 * not have it and the OCR runtime cannot install without it. Left undetected this surfaces as
 * a spawn failure at the moment the user presses Install — the least helpful possible time.
 *
 * Fixable rather than blocking: it is one command away in a checkout, and in a packaged build
 * its absence is a packaging fault worth reporting rather than a machine that cannot run.
 */
function describeInstallerCheck(inputs: PreflightInputs): PreflightCheck {
  if (inputs.installer.present) {
    return {
      id: 'ocr-installer',
      severity: 'ok',
      title: 'OCR runtime installer',
      detail: 'The uv binary that installs Python and PaddleOCR is present.',
      remedy: null,
    };
  }

  return {
    id: 'ocr-installer',
    severity: 'fixable',
    title: 'OCR runtime installer',
    detail:
      `The uv binary is missing from ${inputs.installer.path}. It downloads Python and ` +
      'PaddleOCR, so the OCR runtime cannot be installed without it. Everything else in ' +
      'the application works.',
    remedy: {
      summary: 'Fetch the uv binary (about 44 MB)',
      downloadUrl: null,
      steps: [
        `In a checkout, run: ${FETCH_UV_COMMAND}`,
        'The dev launcher (dev/dev.ps1 or dev/dev.sh) does this for you on Start.',
      ],
    },
  };
}

function describeDiskCheck(inputs: PreflightInputs): PreflightCheck {
  // An unmeasurable filesystem must not block an install; better to try and fail with the
  // installer's own error than to refuse on a network share we simply cannot stat.
  if (inputs.disk === null) {
    return {
      id: 'disk-space',
      severity: 'ok',
      title: 'Free disk space',
      detail: 'Could not measure free space on this filesystem. The install will go ahead.',
      remedy: null,
    };
  }

  if (inputs.disk.freeBytes >= inputs.requiredBytes) {
    return {
      id: 'disk-space',
      severity: 'ok',
      title: 'Free disk space',
      detail: `${formatGib(inputs.disk.freeBytes)} available; about ${formatGib(inputs.requiredBytes)} is needed.`,
      remedy: null,
    };
  }

  return {
    id: 'disk-space',
    severity: 'fixable',
    title: 'Free disk space',
    detail:
      `${formatGib(inputs.disk.freeBytes)} available, but about ` +
      `${formatGib(inputs.requiredBytes)} is needed for Python, PaddleOCR and the models.`,
    remedy: {
      summary: `Free up ${formatGib(inputs.requiredBytes - inputs.disk.freeBytes)} or choose another data directory`,
      downloadUrl: null,
      steps: [
        'Free space on the drive holding the data directory, or',
        'point IMPRESSIVE_OCR_DATA_DIR at a drive with more room and restart.',
      ],
    },
  };
}

/** The blocked checks, for logging and for the installer's own guard. */
export function blockingReasons(report: PreflightReport): string[] {
  return report.checks.filter((check) => check.severity === 'blocked').map((check) => check.detail);
}

/**
 * Raised when an install is attempted on a machine that cannot run the result.
 *
 * Carries the reasons rather than a bare flag: the message the user sees should be the same
 * sentence the System page shows, not a second, vaguer rendering of it.
 */
export class PreflightBlockedError extends Error {
  constructor(readonly report: PreflightReport) {
    const reasons = blockingReasons(report);
    super(
      reasons.length > 0
        ? `${PREFLIGHT_BLOCKED_MESSAGE} ${reasons.join(' ')}`
        : PREFLIGHT_BLOCKED_MESSAGE,
    );
    this.name = 'PreflightBlockedError';
  }
}
