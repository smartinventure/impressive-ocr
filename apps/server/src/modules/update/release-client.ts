// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from '../../infra/logger';

/**
 * The GitHub releases feed, behind an interface.
 *
 * A seam rather than `fetch` inside the service, for the same reason `LicenseClient` is one:
 * everything that decides *whether to offer an update* stays testable without a network, and
 * the single file that talks to api.github.com is this one.
 */

export interface LatestRelease {
  /** The tag with any leading `v` left on; the caller parses it. */
  version: string;
  releaseNotesUrl: string | null;
}

export interface ReleaseClient {
  /** Null when the feed was read but held no usable release. Throws when it could not be read. */
  latestRelease(signal: AbortSignal): Promise<LatestRelease | null>;
}

export interface GitHubReleaseClientConfig {
  /** `owner/repo`. */
  repository: string;
  /** Hard ceiling on the request. A hung check must never hold a page load open. */
  timeoutMs: number;
}

export const DEFAULT_RELEASE_TIMEOUT_MS = 8_000;

/** Shape of the one endpoint used, narrowed from a much larger response. */
interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

export class GitHubReleaseClient implements ReleaseClient {
  constructor(
    private readonly config: GitHubReleaseClientConfig,
    private readonly logger: Logger,
  ) {}

  async latestRelease(signal: AbortSignal): Promise<LatestRelease | null> {
    const url = `https://api.github.com/repos/${this.config.repository}/releases/latest`;

    // Two signals: the caller's, and our own timeout. `AbortSignal.any` means a shutdown
    // cancels the request immediately rather than waiting out the timeout.
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects unidentified clients, and the version makes a rate-limit complaint
        // traceable to a release rather than to "some Node process".
        'User-Agent': 'impressive-ocr-update-check',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      // 403 with a rate-limit header is the common one on a shared address. Logged at debug
      // because a failed update check is not an operational problem worth waking anyone for.
      this.logger.debug(
        { status: response.status, repository: this.config.repository },
        'Release feed returned an error status',
      );
      throw new Error(`Release feed returned ${response.status}`);
    }

    const payload: unknown = await response.json();
    return readRelease(payload);
  }
}

/**
 * Narrow the response without trusting any of it.
 *
 * Crossing the boundary as `unknown` and checking each field, rather than casting: this is a
 * third-party response, and a `tag_name` that is not a string must produce "no release" and
 * not a `TypeError` three frames away.
 */
function readRelease(payload: unknown): LatestRelease | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const release = payload as GitHubRelease;

  // `releases/latest` already excludes drafts and pre-releases, but the flags are checked
  // anyway: the endpoint is one URL away from `releases`, which does not.
  if (release.draft === true || release.prerelease === true) return null;

  const version = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (version === '') return null;

  return {
    version,
    releaseNotesUrl: typeof release.html_url === 'string' ? release.html_url : null,
  };
}
