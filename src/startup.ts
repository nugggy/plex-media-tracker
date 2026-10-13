import { isConfigured, getSetting } from './db.ts';
import { runRefresh } from './scanner.ts';
import { maybeAutoBuildTrending } from './trendingauto.ts';

/**
 * How recent the last full refresh may be for a start to skip its own. A phone
 * is opened many times a day, and the watchlist, schedules and library do not
 * change by the hour.
 */
export const SYNC_ON_START_GAP_MS = 2 * 3_600_000;

/** True unless a full refresh finished cleanly within the gap. */
export function syncDueOnStart(lastRefreshAt: string, now: number = Date.now()): boolean {
  const finished = Date.parse(lastRefreshAt);
  if (Number.isNaN(finished)) return true;
  const age = now - finished;
  // A negative age means the clock moved; trust nothing and sync.
  return age < 0 || age > SYNC_ON_START_GAP_MS;
}

/**
 * Catches up on the watchlist, episodes and library on start, so the
 * dashboard is current the moment it opens. The slow MusicBrainz scan is
 * deliberately left for the Scan button. Trending charts more than a week old
 * are rebuilt too. Shared by the PC server and the phone.
 */
export function startBackgroundSync(): boolean {
  if (!isConfigured() || getSetting('sync_on_start') !== '1') return false;
  // Out-of-date trending charts are rebuilt whether or not the refresh below
  // is due, since a phone opened every hour would otherwise rarely get one.
  // Turning off sync on start turns this off too; opening the Trending tab
  // still catches the charts up.
  maybeAutoBuildTrending();
  if (!syncDueOnStart(getSetting('last_refresh_at'))) return false;
  void runRefresh();
  return true;
}
