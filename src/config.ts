import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, existsSync, renameSync, readFileSync } from 'node:fs';

import { APP_VERSION } from './version.ts';

export { APP_VERSION };
export const APP_NAME = 'Plex Media Tracker';

/** The folder this app used before it was renamed. Its data is carried over. */
const LEGACY_FOLDER = 'WaxWrangler';
const FOLDER = 'PlexMediaTracker';

/**
 * The database deliberately lives outside the project folder. The project sits
 * in OneDrive, and OneDrive syncing a SQLite file mid-write corrupts it.
 */
function defaultDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return join(localAppData, FOLDER);
  return join(homedir(), `.${FOLDER.toLowerCase()}`);
}

function legacyDataDir(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return join(localAppData, LEGACY_FOLDER);
  const home = join(homedir(), '.wax-wrangler');
  return home;
}

/**
 * A test file that forgets to choose its own folder must never reach the real
 * database. On 13/10/2026 a test run upgraded the live one in place. The test
 * runner marks each file's process with NODE_TEST_CONTEXT, so those processes
 * fall back to a throwaway folder of their own, which also stops parallel
 * files fighting over one database lock.
 */
if (process.env.NODE_TEST_CONTEXT && !(process.env.PLEX_TRACKER_DATA_DIR ?? process.env.WAX_WRANGLER_DATA_DIR)) {
  process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-test-'));
}

export const DATA_DIR =
  process.env.PLEX_TRACKER_DATA_DIR ?? process.env.WAX_WRANGLER_DATA_DIR ?? defaultDataDir();

export const DB_PATH = join(DATA_DIR, 'plex-media-tracker.db');
export const PORT = Number(process.env.PLEX_TRACKER_PORT ?? process.env.WAX_WRANGLER_PORT ?? 7000);

/**
 * Where the server listens. Loopback on a PC, so nothing else can reach it.
 * The NAS container sets 0.0.0.0, since the phone and other browsers need in.
 */
export const HOST = process.env.PLEX_TRACKER_HOST ?? '127.0.0.1';

export function isLoopback(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host);
}

/**
 * Whether every visitor has to sign in with Plex. A server that only this
 * machine can reach needs no sign-in; one that listens on the network always
 * does, unless PLEX_TRACKER_AUTH=off says otherwise.
 */
export const AUTH_REQUIRED =
  (process.env.PLEX_TRACKER_AUTH ?? (isLoopback(HOST) ? 'off' : 'plex')) !== 'off';

/**
 * True when a reverse proxy (Caddy, in the NAS setup) sits in front and its
 * X-Forwarded-Proto and X-Forwarded-For headers can be believed.
 */
export const TRUST_PROXY = process.env.PLEX_TRACKER_TRUST_PROXY === '1';

/**
 * Where the NAS's shared folders are mounted inside the container, so lyric
 * files can be written straight to disk instead of over the network. Empty on
 * a PC, which reaches the same folders over SMB.
 */
export const MEDIA_ROOT = process.env.PLEX_TRACKER_MEDIA_ROOT ?? '';

/** The server's address on the home network, offered to the phone as a second way in. */
export const LAN_URL = process.env.PLEX_TRACKER_LAN_URL ?? '';

/** The public name the proxy answers to, such as yourname.duckdns.org. */
export const PUBLIC_HOST = (process.env.PLEX_TRACKER_PUBLIC_HOST ?? '').trim().toLowerCase();

/**
 * The names the NAS server answers to: its public name, its home address and
 * loopback (for the container's health check). Anything else is a web page
 * that has pointed its own name at the NAS (DNS rebinding) and is refused.
 * Empty when neither name is set, and then any name is accepted.
 */
export function allowedHosts(): Set<string> {
  const out = new Set<string>();
  if (PUBLIC_HOST) {
    out.add(PUBLIC_HOST);
    out.add(`${PUBLIC_HOST}:443`);
  }
  if (LAN_URL) {
    try {
      out.add(new URL(LAN_URL).host.toLowerCase());
    } catch {
      // A malformed address names nothing.
    }
  }
  if (out.size === 0) return out;
  out.add(`localhost:${PORT}`);
  out.add(`127.0.0.1:${PORT}`);
  return out;
}

export const USER_AGENT = `PlexMediaTracker/${APP_VERSION} ( local personal use )`;

/**
 * True when the files on disk have moved to a newer version than the server
 * that is running. The page is read fresh from disk but the server is not, so
 * after an update the new buttons would talk to the old server until the app
 * is restarted.
 */
export function restartNeeded(): boolean {
  try {
    const text = readFileSync(join(import.meta.dirname, 'version.ts'), 'utf8');
    const onDisk = text.match(/APP_VERSION = '([^']+)'/)?.[1];
    return Boolean(onDisk && onDisk !== APP_VERSION);
  } catch {
    return false;
  }
}

/**
 * Moves data left behind by the old name, so a rename never loses a library
 * that took half an hour to build. Anything already in place wins.
 */
function migrateLegacyData(): void {
  if (process.env.PLEX_TRACKER_DATA_DIR ?? process.env.WAX_WRANGLER_DATA_DIR) return;

  const legacyDir = legacyDataDir();
  if (!legacyDir || !existsSync(legacyDir)) return;

  const legacyDb = join(legacyDir, 'wax-wrangler.db');
  if (!existsSync(legacyDb) || existsSync(DB_PATH)) return;

  mkdirSync(DATA_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${legacyDb}${suffix}`;
    const to = `${DB_PATH}${suffix}`;
    if (existsSync(from) && !existsSync(to)) {
      try {
        renameSync(from, to);
      } catch {
        // A locked or missing sidecar file is not fatal; SQLite rebuilds them.
      }
    }
  }
}

export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyData();
}
