/**
 * The phone's stand-in for src/config.ts. The phone build swaps this in, so it
 * has to export every name the PC version does. There are no paths here: the
 * phone's database lives in app storage, handled by mobile/sqlite-driver.ts.
 */
import { APP_VERSION } from '../src/version.ts';

export { APP_VERSION };
export const APP_NAME = 'Plex Media Tracker';
export const PLATFORM: 'desktop' | 'mobile' = 'mobile';
export const DATA_DIR = '';
export const DB_PATH = '';
export const PORT = 0;
export const USER_AGENT = `PlexMediaTracker/${APP_VERSION} ( Android personal use )`;
export function ensureDataDir(): void {}
