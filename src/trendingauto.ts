/**
 * Keeping the Trending charts current without a button press. The charts are
 * weekly, so once the oldest is more than a week old a rebuild starts on its
 * own, when the app starts and when the Trending tab is opened.
 *
 * Shared by the PC server and the phone: both start through startup.ts and
 * both answer the tab through api.ts, so neither needs its own copy.
 */
import { getSetting, isConfigured, setSetting } from './db.ts';
import { createJob } from './jobs.ts';
import { builtAt, buildTrending, type TrendingKind } from './trending.ts';
import { musicScanRunning } from './scanner.ts';

/**
 * The one trending build, whoever started it. The Build button and the
 * automatic rebuild share it, so the two can never run at once.
 */
export const trendingJob = createJob();

/** Charts are weekly, so a week is when one is out of date. */
export const TRENDING_MAX_AGE_MS = 7 * 86_400_000;

/** After an automatic build fails, this long passes before another is tried. */
export const TRENDING_RETRY_GAP_MS = 6 * 3_600_000;

/** When the last automatic build ended badly. Kept so a restart does not retry at once. */
const FAILED_AT = 'trending_auto_failed_at';

/**
 * The charts that can be built at all. Films and shows need a TMDB key, and
 * without one they are never built, so counting them would call the charts
 * stale forever and rebuild them on every visit to the tab.
 */
export function buildableKinds(hasTmdbKey: boolean): TrendingKind[] {
  return hasTmdbKey ? ['movie', 'show', 'album'] : ['album'];
}

/** True when any chart that can be built is missing or more than a week old. */
export function trendingStale(
  at: Record<TrendingKind, string | null>,
  hasTmdbKey: boolean,
  now: number = Date.now(),
): boolean {
  return buildableKinds(hasTmdbKey).some((kind) => {
    const stamp = at[kind];
    if (!stamp) return true;
    const built = Date.parse(stamp);
    if (Number.isNaN(built)) return true;
    // A build stamped in the future means the clock moved; trust nothing.
    const age = now - built;
    return age < 0 || age > TRENDING_MAX_AGE_MS;
  });
}

export interface AutoBuildInput {
  stale: boolean;
  configured: boolean;
  /** A trending build, automatic or from the button, is already running. */
  building: boolean;
  /** A full scan or Artists check is using MusicBrainz. */
  scanning: boolean;
  /** When the last automatic build failed, or '' when none has. */
  lastFailureAt: string;
  now?: number;
}

/**
 * Whether to start an automatic rebuild now. Pure, so every rule can be
 * tested without a network.
 *
 * MusicBrainz is shared through one queue in musicbrainz.ts that spaces every
 * request a second apart whoever makes it, so running alongside a scan could
 * never break the rate limit. It would still slow the scan, which can be many
 * minutes of MusicBrainz work already, so an automatic build waits for the
 * next start or visit to the tab instead. A quick refresh uses no
 * MusicBrainz, so it does not hold a build back. The Build button is not
 * subject to any of this: a press is a deliberate choice.
 */
export function shouldAutoBuild(input: AutoBuildInput): boolean {
  if (!input.stale || !input.configured || input.building || input.scanning) return false;
  const failed = Date.parse(input.lastFailureAt);
  if (!Number.isNaN(failed)) {
    const since = (input.now ?? Date.now()) - failed;
    // A failure in the future means the clock moved, so it is not trusted to
    // hold builds back.
    if (since >= 0 && since < TRENDING_RETRY_GAP_MS) return false;
  }
  return true;
}

function hasTmdbKey(): boolean {
  return getSetting('tmdb_api_key').trim() !== '';
}

/** Whether the charts the tab shows are out of date right now. */
export function trendingIsStale(): boolean {
  return trendingStale(builtAt(), hasTmdbKey());
}

/**
 * Starts a rebuild in the background when the charts are out of date and
 * nothing stands in the way. Returns at once either way; true when one began.
 *
 * buildTrending catches each source's failure itself so the other charts
 * still build, which means it rarely throws. A build that ends with the
 * charts still out of date is therefore treated as failed too, since that is
 * what would otherwise be retried on every visit to the tab.
 */
export function maybeAutoBuildTrending(): boolean {
  const go = shouldAutoBuild({
    stale: trendingIsStale(),
    configured: isConfigured(),
    building: trendingJob.progress().running,
    scanning: musicScanRunning(),
    lastFailureAt: getSetting(FAILED_AT),
  });
  if (!go) return false;

  trendingJob.begin('Starting', 'Trending is already being built.');
  void buildTrending((m) => trendingJob.say(m))
    .then((r) => {
      const ok = !trendingIsStale();
      if (!ok) setSetting(FAILED_AT, new Date().toISOString());
      trendingJob.end(r.message, ok);
    })
    .catch((e: Error) => {
      setSetting(FAILED_AT, new Date().toISOString());
      trendingJob.end(`Failed: ${e.message}`, false);
    });
  return true;
}
