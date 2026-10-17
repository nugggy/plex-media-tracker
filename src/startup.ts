import { isConfigured, getSetting, setSetting } from './db.ts';
import { getProgress, runRefresh, runScan } from './scanner.ts';
import { nowIso } from './dates.ts';
import { AUTH_REQUIRED } from './config.ts';
import { maybeAutoBuildTrending } from './trendingauto.ts';

/**
 * How recent the last full refresh may be for a start to skip its own. A phone
 * is opened many times a day, and the watchlist, schedules and library do not
 * change by the hour.
 */
export const SYNC_ON_START_GAP_MS = 2 * 3_600_000;

/**
 * The NAS is always on and nothing else prompts it, so it refreshes hourly:
 * a film added to the watchlist or an episode that has just aired shows
 * within the hour. The quick refresh never touches MusicBrainz, so this costs
 * a couple of minutes of Plex and plex.tv calls an hour.
 */
export const SERVER_REFRESH_GAP_MS = 3_600_000;

/** The gap that applies here: hourly on the NAS, two hours on a PC. */
export const REFRESH_GAP_MS = AUTH_REQUIRED ? SERVER_REFRESH_GAP_MS : SYNC_ON_START_GAP_MS;

/** How often a long-running server asks whether a sync is due. */
export const SYNC_CHECK_EVERY_MS = 15 * 60_000;

/** True unless a full refresh finished cleanly within the gap. */
export function syncDueOnStart(
  lastRefreshAt: string,
  now: number = Date.now(),
  gapMs: number = SYNC_ON_START_GAP_MS,
): boolean {
  const finished = Date.parse(lastRefreshAt);
  if (Number.isNaN(finished)) return true;
  const age = now - finished;
  // A negative age means the clock moved; trust nothing and sync.
  return age < 0 || age > gapMs;
}

/**
 * Catches up on the watchlist, episodes and library on start, so the
 * dashboard is current the moment it opens. The slow MusicBrainz scan is
 * deliberately left for the Scan button. Trending charts more than a week old
 * are rebuilt too. On the NAS the server also calls this every 15 minutes.
 */
export function startBackgroundSync(): boolean {
  if (!isConfigured() || getSetting('sync_on_start') !== '1') return false;
  // Out-of-date trending charts are rebuilt whether or not the refresh below
  // is due, since a phone opened every hour would otherwise rarely get one.
  // Turning off sync on start turns this off too; opening the Trending tab
  // still catches the charts up.
  maybeAutoBuildTrending();
  if (!syncDueOnStart(getSetting('last_refresh_at'), Date.now(), REFRESH_GAP_MS)) return false;
  void runRefresh();
  return true;
}

/** The NAS's music scan runs in this Sydney hour, when nobody is waiting on it. */
export const NIGHTLY_SCAN_HOUR = 3;

function sydneyHour(at: number): number {
  const text = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
  return Number(text);
}

/**
 * True in the small hours, Sydney time, when the last nightly scan was not
 * started within the last 20 hours. The gap is short of a day so that a scan
 * started a little late one night does not push the next one back a night.
 */
export function nightlyScanDue(lastStartedAt: string, now: number = Date.now()): boolean {
  if (sydneyHour(now) !== NIGHTLY_SCAN_HOUR) return false;
  const last = Date.parse(lastStartedAt);
  return Number.isNaN(last) || now - last > 20 * 3_600_000;
}

/**
 * On the NAS, a full check (the quick refresh and then MusicBrainz) once a
 * night, standing in for the scheduled task the PC used. The MusicBrainz part
 * only asks about artists not checked in the last week, so most nights are
 * short.
 */
export function maybeNightlyScan(now: number = Date.now()): boolean {
  if (!isConfigured() || getProgress().running) return false;
  if (!nightlyScanDue(getSetting('last_nightly_scan_at'), now)) return false;
  setSetting('last_nightly_scan_at', nowIso());
  void runScan();
  return true;
}
