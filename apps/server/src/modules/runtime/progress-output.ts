// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turns a line of installer output into something worth showing a user, or nothing.
 *
 * `uv`, `pip` and Hugging Face all write progress bars to the console, and those bars are
 * written for a terminal that can redraw a line. Piped into a status field they arrive as
 * hundreds of near-identical strings full of block characters:
 *
 *     Fetching 6 files:  17%|#6        | 1/6 [00:00<00:01,  4.80it/s]
 *
 * The step already says what is happening ("Downloading OCR models"), so the bar adds no
 * information — only noise, and a status line that appears to be corrupted.
 *
 * Filtering here rather than in the UI keeps the raw text in the debug log, where it is
 * genuinely useful when an install fails.
 */

/** CSI escape sequences: colour, cursor movement, line clears. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Anything a terminal uses to redraw in place. */
// eslint-disable-next-line no-control-regex -- ditto
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * Signatures of a progress bar rather than a message.
 *
 * Matched against the cleaned line, so a bar that arrived with escape codes is still caught.
 */
const PROGRESS_PATTERNS: readonly RegExp[] = [
  // tqdm: "17%|#6        | 1/6" — a percentage followed by a bar column.
  /\d+%\s*\|/,
  // tqdm's rate suffix, present even when the bar itself is empty.
  /\[\d\d:\d\d<[\d?:]+,\s*[\d.?]+\s*(it|B)\/s\]/,
  // A bare rate, e.g. "4.80it/s".
  /\d+(\.\d+)?\s*(it|kB|MB|GB|B)\/s/,
  // uv and pip draw bars from block-drawing characters.
  /[\u2580-\u259F\u2500-\u257F]{3,}/,
  // A line that is only hashes and pipes: the ASCII fallback bar.
  /^[#|\s.\d%/-]+$/,
];

/**
 * Clean a line, or return `null` when it should not be shown.
 *
 * A returned string is safe to put straight into a status field: no control characters, no
 * carriage returns, and trimmed.
 */
export function toUserMessage(line: string): string | null {
  const cleaned = line
    .replace(ANSI_PATTERN, '')
    // A single physical line can carry several redraws separated by \r; the last one is the
    // most recent state, so anything earlier is already stale.
    .split(/\r/)
    .pop()!
    .replace(CONTROL_PATTERN, '')
    .trim();

  if (cleaned.length === 0) return null;
  if (PROGRESS_PATTERNS.some((pattern) => pattern.test(cleaned))) return null;

  // Long enough to be a stack trace or a wall of paths: truncate rather than let it overflow
  // a single-line status field.
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}
