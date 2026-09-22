/**
 * Housekeeping for the library itself: gaps in seasons, duplicate files,
 * anything worth upgrading, and deep links back into Plex.
 *
 * All of it comes from data the refresh already pulls over the LAN, so none of
 * this costs an extra round trip to the internet.
 */
import { db } from './db.ts';
import * as store from './db.ts';
import { today } from './dates.ts';

/* ------------------------------------------------------------- migrations */

for (const sql of [
  'ALTER TABLE library_guids ADD COLUMN rating_key TEXT',
  'ALTER TABLE library_guids ADD COLUMN file_count INTEGER',
  'ALTER TABLE library_guids ADD COLUMN resolution TEXT',
  'ALTER TABLE library_guids ADD COLUMN codec TEXT',
  'ALTER TABLE library_guids ADD COLUMN size INTEGER',
  'ALTER TABLE local_episodes ADD COLUMN rating_key TEXT',
  'ALTER TABLE local_episodes ADD COLUMN file_count INTEGER',
  'ALTER TABLE local_episodes ADD COLUMN resolution TEXT',
  'ALTER TABLE local_episodes ADD COLUMN title TEXT',
]) {
  try {
    db.exec(sql);
  } catch {
    // Column already present.
  }
}

/* ------------------------------------------------------------- deep links */

/**
 * Opens an item in the Plex app. The server id is stored during a refresh; with
 * no id there is no link, and callers show nothing rather than a broken one.
 */
export function deepLink(ratingKey: string | null | undefined): string | null {
  const machine = store.getSetting('plex_machine_id');
  if (!machine || !ratingKey) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${machine}/details?key=${key}`;
}

export async function fetchMachineId(baseUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/?X-Plex-Token=${token}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    return data.MediaContainer?.machineIdentifier ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- missing episodes */

export interface MissingRun {
  show_guid: string;
  show: string;
  rating_key: string | null;
  season: number;
  missing: number[];
  reason: 'gap' | 'aired';
  held: number;
}

/**
 * Two kinds of hole, reported separately because they mean different things.
 *
 * A "gap" is an episode missing between two you hold, which is certain: nothing
 * legitimately skips episode 3. An "aired" hole is an episode the show has
 * broadcast that is not on the server, which needs the watchlist to know about.
 * Trailing numbers are never guessed at, so a season still airing is not
 * reported as broken.
 */
export function missingEpisodes(): MissingRun[] {
  const rows = db
    .prepare(
      `SELECT le.show_guid, le.season, le.episode, COALESCE(g.title, le.show_guid) AS title,
              g.rating_key
       FROM local_episodes le
       LEFT JOIN library_guids g ON g.guid = le.show_guid
       ORDER BY le.show_guid, le.season, le.episode`,
    )
    .all() as {
    show_guid: string;
    season: number;
    episode: number;
    title: string;
    rating_key: string | null;
  }[];

  const bySeason = new Map<string, { info: (typeof rows)[0]; eps: Set<number> }>();
  for (const r of rows) {
    const key = `${r.show_guid}|${r.season}`;
    const entry = bySeason.get(key);
    if (entry) entry.eps.add(r.episode);
    else bySeason.set(key, { info: r, eps: new Set([r.episode]) });
  }

  const out: MissingRun[] = [];

  for (const { info, eps } of bySeason.values()) {
    const nums = [...eps].sort((a, b) => a - b);
    const lo = nums[0]!;
    const hi = nums[nums.length - 1]!;
    const gaps: number[] = [];
    for (let n = lo; n <= hi; n += 1) if (!eps.has(n)) gaps.push(n);
    if (gaps.length > 0) {
      out.push({
        show_guid: info.show_guid,
        show: info.title,
        rating_key: info.rating_key,
        season: info.season,
        missing: gaps,
        reason: 'gap',
        held: eps.size,
      });
    }
  }

  // Episodes the watchlist says have aired but that are not on the server.
  const aired = db
    .prepare(
      `SELECT w.guid AS show_guid, e.show_title AS title, e.season, e.episode, g.rating_key
       FROM episodes e
       JOIN watchlist_items w ON w.rating_key = e.show_key
       LEFT JOIN library_guids g ON g.guid = w.guid
       WHERE w.state = 'listed' AND e.air_date IS NOT NULL AND e.air_date <= ?
         AND e.season IS NOT NULL AND e.episode IS NOT NULL
         AND w.guid IN (SELECT DISTINCT show_guid FROM local_episodes)
         AND NOT EXISTS (SELECT 1 FROM local_episodes le
                         WHERE le.show_guid = w.guid AND le.season = e.season
                           AND le.episode = e.episode)
       ORDER BY e.show_title, e.season, e.episode`,
    )
    .all(today()) as {
    show_guid: string;
    title: string;
    season: number;
    episode: number;
    rating_key: string | null;
  }[];

  const airedBySeason = new Map<string, MissingRun>();
  for (const a of aired) {
    const key = `${a.show_guid}|${a.season}`;
    const already = out.find((o) => o.show_guid === a.show_guid && o.season === a.season);
    if (already?.missing.includes(a.episode)) continue; // already reported as a gap

    const entry = airedBySeason.get(key);
    if (entry) entry.missing.push(a.episode);
    else {
      airedBySeason.set(key, {
        show_guid: a.show_guid,
        show: a.title,
        rating_key: a.rating_key,
        season: a.season,
        missing: [a.episode],
        reason: 'aired',
        held: 0,
      });
    }
  }

  out.push(...airedBySeason.values());
  return out.sort(
    (a, b) => a.show.localeCompare(b.show) || a.season - b.season,
  );
}

/* ------------------------------------------------- duplicates and quality */

export interface LibraryItem {
  rating_key: string | null;
  title: string;
  year: number | null;
  type: string;
  season: number | null;
  episode: number | null;
  file_count: number;
  resolution: string | null;
  codec: string | null;
  size: number | null;
}

/** More than one file for the same thing, which is usually an accident. */
export function duplicates(): LibraryItem[] {
  const films = db
    .prepare(
      `SELECT rating_key, title, year, type, NULL AS season, NULL AS episode,
              file_count, resolution, codec, size
       FROM library_guids WHERE file_count > 1 ORDER BY title COLLATE NOCASE`,
    )
    .all() as unknown as LibraryItem[];

  const eps = db
    .prepare(
      `SELECT le.rating_key, COALESCE(g.title, le.show_guid) AS title, NULL AS year,
              'episode' AS type, le.season, le.episode, le.file_count, le.resolution,
              NULL AS codec, NULL AS size
       FROM local_episodes le
       LEFT JOIN library_guids g ON g.guid = le.show_guid
       WHERE le.file_count > 1
       ORDER BY title COLLATE NOCASE, le.season, le.episode`,
    )
    .all() as unknown as LibraryItem[];

  return [...films, ...eps];
}

/** Anything below 1080p, worth replacing if a better copy exists. */
const LOW = ["'sd'", "'480'", "'576'", "'720'"].join(',');

export function upgradeCandidates(): LibraryItem[] {
  const films = db
    .prepare(
      `SELECT rating_key, title, year, type, NULL AS season, NULL AS episode,
              file_count, resolution, codec, size
       FROM library_guids
       WHERE type = 'movie' AND LOWER(COALESCE(resolution, '')) IN (${LOW})
       ORDER BY title COLLATE NOCASE`,
    )
    .all() as unknown as LibraryItem[];
  return films;
}

export interface LibraryReport {
  machineId: boolean;
  missing: MissingRun[];
  missingCount: number;
  duplicates: LibraryItem[];
  upgrades: LibraryItem[];
  resolutions: { resolution: string; n: number }[];
}

export function libraryReport(): LibraryReport {
  const missing = missingEpisodes();
  const res = db
    .prepare(
      `SELECT LOWER(COALESCE(resolution, 'unknown')) AS resolution, COUNT(*) AS n
       FROM library_guids WHERE type = 'movie' GROUP BY resolution ORDER BY n DESC`,
    )
    .all() as { resolution: string; n: number }[];

  return {
    machineId: Boolean(store.getSetting('plex_machine_id')),
    missing,
    missingCount: missing.reduce((sum, m) => sum + m.missing.length, 0),
    duplicates: duplicates(),
    upgrades: upgradeCandidates(),
    resolutions: res,
  };
}
