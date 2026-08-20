// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FileStability } from '../../infra/fs/file-ops';

/**
 * Decides when a file has finished arriving.
 *
 * A watcher fires the moment a file appears, but the copy may still be in progress —
 * especially over SMB, where a 200 MB scan can take a minute. OCR-ing a half-written PDF
 * fails, so every file waits until its size and mtime have stopped changing for the
 * pipeline's stability window.
 *
 * Kept as a pure state machine so the timing rules can be tested without real files, real
 * clocks, or a real network share.
 */

export interface StabilityCandidate {
  path: string;
  /** Last observed size and mtime. */
  last: FileStability;
  /** When the file was first observed with these exact values. */
  unchangedSinceMs: number;
}

export type StabilityVerdict =
  | { kind: 'stable' }
  | { kind: 'still-changing' }
  | { kind: 'waiting'; remainingMs: number }
  | { kind: 'vanished' };

/**
 * Fold a fresh observation into a candidate's state.
 *
 * Returns both the verdict and the candidate to carry forward, so the caller never has to
 * mutate anything in place.
 */
export function observe(
  candidate: StabilityCandidate,
  current: FileStability | null,
  nowMs: number,
  windowMs: number,
): { verdict: StabilityVerdict; next: StabilityCandidate } {
  if (current === null) {
    return { verdict: { kind: 'vanished' }, next: candidate };
  }

  if (!isSameStat(candidate.last, current)) {
    // Still growing, or being rewritten. Restart the clock rather than counting from the
    // first sighting — otherwise a slow copy would be declared stable mid-transfer.
    return {
      verdict: { kind: 'still-changing' },
      next: { path: candidate.path, last: current, unchangedSinceMs: nowMs },
    };
  }

  const elapsed = nowMs - candidate.unchangedSinceMs;
  if (elapsed >= windowMs) {
    return { verdict: { kind: 'stable' }, next: candidate };
  }
  return {
    verdict: { kind: 'waiting', remainingMs: windowMs - elapsed },
    next: candidate,
  };
}

export function isSameStat(a: FileStability, b: FileStability): boolean {
  return a.sizeBytes === b.sizeBytes && a.modifiedAtMs === b.modifiedAtMs;
}

export function beginTracking(
  path: string,
  stat: FileStability,
  nowMs: number,
): StabilityCandidate {
  return { path, last: stat, unchangedSinceMs: nowMs };
}

/**
 * Files that are obviously not finished being written.
 *
 * Office and many scanners write a temporary sibling first (`~$report.docx`,
 * `.scan.pdf.tmp`) and rename it into place. Matching on the name is cheap and avoids a
 * whole class of pointless queue churn.
 */
const TEMP_PATTERNS = [/^~\$/, /^\.~/, /\.tmp$/i, /\.crdownload$/i, /\.partial$/i, /\.part$/i];

export function looksTemporary(fileName: string): boolean {
  return TEMP_PATTERNS.some((pattern) => pattern.test(fileName));
}
