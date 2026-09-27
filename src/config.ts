import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, renameSync } from 'node:fs';

import { APP_VERSION } from './version.ts';

export { APP_VERSION };
export const APP_NAME = 'Plex Media Tracker';
/** The phone build swaps this file for mobile/config.ts, where this is 'mobile'. */
export const PLATFORM: 'desktop' | 'mobile' = 'desktop';

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

export const DATA_DIR =
  process.env.PLEX_TRACKER_DATA_DIR ?? process.env.WAX_WRANGLER_DATA_DIR ?? defaultDataDir();

export const DB_PATH = join(DATA_DIR, 'plex-media-tracker.db');
export const PORT = Number(process.env.PLEX_TRACKER_PORT ?? process.env.WAX_WRANGLER_PORT ?? 7000);

export const USER_AGENT = `PlexMediaTracker/${APP_VERSION} ( local personal use )`;

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
