/**
 * Turns the path Plex reports for a song into the path this PC uses to reach
 * the same file over the network, and names the lyric file that goes beside
 * it. Pure, so the phone build and the tests can use it without a disk.
 *
 * Plex on a QNAP reports `/share/CACHEDEV1_DATA/<shared folder>/...`, and the
 * same folder is shared as `\<NAS address>\<shared folder>\...`.
 */

const QNAP_PATH = /^\/share\/(?:(?:CACHEDEV\d+|MD\d+|HDA)_DATA\/)?([^/]+)\/(.+)$/;

/** The NAS's address on the home network, or null when Plex was reached some other way. */
export function nasHost(plexUrl: string): string | null {
  let host: string;
  try {
    host = new URL(plexUrl).hostname;
  } catch {
    return null;
  }
  // A plex.direct name carries the server's own address, dashed.
  const direct = host.match(/^(\d+-\d+-\d+-\d+)\.[^.]+\.plex\.direct$/);
  if (direct) host = direct[1]!.replace(/-/g, '.');
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+/.test(host)) return host;
  if (/^(\d+\.){3}\d+$/.test(host)) return null; // a public address, so not at home
  if (!host.includes('.') || host.endsWith('.local')) return host;
  return null;
}

/**
 * True when any part of the path, split on either kind of slash, is "..". A
 * path from Plex is trusted to name a song, not to climb out of the share, so
 * one that tries is refused rather than tidied up. Windows drops trailing dots
 * and spaces from a folder name, so "... " is treated as ".." too.
 */
export function climbsOut(path: string): boolean {
  return path.split(/[\\/]/).some((part) => /^\s*\.\.[.\s]*$/.test(part));
}

export function toSharePath(plexFile: string, plexUrl: string): string | null {
  const host = nasHost(plexUrl);
  if (climbsOut(plexFile)) return null;
  const m = plexFile.match(QNAP_PATH);
  if (!host || !m) return null;
  return `\\\\${host}\\${m[1]}\\${m[2]!.replace(/\//g, '\\')}`;
}

/** The song's own path and name with the extension swapped, which is how Plex pairs them. */
export function sidecarPath(songPath: string, extension: 'lrc' | 'txt'): string {
  const dot = songPath.lastIndexOf('.');
  const slash = Math.max(songPath.lastIndexOf('\\'),songPath.lastIndexOf('/'));
  const stem = dot > slash ? songPath.slice(0, dot) : songPath;
  return `${stem}.${extension}`;
}
