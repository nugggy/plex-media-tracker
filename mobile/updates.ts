/**
 * Deciding whether a GitHub release is an update for the installed app. Kept
 * free of any network or Android code so it can be tested on its own; the
 * download and install happen in the native Updater plugin, which checks the
 * APK's signature and version again before Android is asked to install it.
 */

/** Only downloads from this repository's releases are ever offered. */
const DOWNLOAD_PREFIX = 'https://github.com/nugggy/plex-media-tracker/releases/download/';

/**
 * The public releases page. It redirects to the newest release's tag, and
 * unlike the API it is not capped at 60 requests an hour per connection.
 */
export const LATEST_RELEASE_PAGE = 'https://github.com/nugggy/plex-media-tracker/releases/latest';

export const LATEST_RELEASE_API =
  'https://api.github.com/repos/nugggy/plex-media-tracker/releases/latest';

/** Negative when a is older than b, zero when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface Asset {
  name?: string;
  browser_download_url?: string;
}

export interface Update {
  version: string;
  url: string;
}

/**
 * An update from the newest tag alone. The release workflow always names the
 * file plex-media-tracker-<version>.apk, and the native side checks the APK's
 * signature and version before installing, so a guessed URL cannot do harm.
 */
export function updateFromTag(tag: string, installed: string): Update | null {
  if (!/^v\d+(\.\d+)*$/.test(tag)) return null;
  const version = tag.slice(1);
  if (compareVersions(version, installed) <= 0) return null;
  return { version, url: `${DOWNLOAD_PREFIX}${tag}/plex-media-tracker-${version}.apk` };
}

/** Plain words for an HTTP status from GitHub. */
export function githubProblem(status: number): string {
  if (status === 403 || status === 429) {
    return 'GitHub is limiting requests from your internet connection for now. Try again in an hour.';
  }
  if (status >= 500) return 'GitHub is having trouble right now. Try again shortly.';
  return `GitHub did not answer as expected (HTTP ${status}). Try again shortly.`;
}

export function pickUpdate(release: unknown, installed: string): Update | null {
  if (!release || typeof release !== 'object') return null;
  const r = release as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Asset[] };
  if (!r.tag_name || r.draft || r.prerelease) return null;
  const version = r.tag_name.replace(/^v/i, '');
  if (compareVersions(version, installed) <= 0) return null;
  const asset = (r.assets ?? []).find(
    (a) =>
      a.name?.toLowerCase().endsWith('.apk') &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(DOWNLOAD_PREFIX),
  );
  return asset ? { version, url: asset.browser_download_url! } : null;
}
