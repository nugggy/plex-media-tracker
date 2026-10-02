/**
 * Episode-level tracking for shows on the watchlist.
 *
 * The watchlist itself only carries a show's last episode date, which answers
 * "something aired" but not "which one, and what is next". Plex Discover will
 * list a season's episodes including ones not yet aired, so this walks the
 * latest seasons of every continuing show and records them individually.
 *
 * Cost is two requests per show: one for its seasons, one for the newest
 * season. Requests are spaced out to stay a polite client.
 */
import { db } from './db.ts';
import * as store from './db.ts';
import { today, daysAgo, nowIso } from './dates.ts';
import {
  resolveAir,
  showAirTimes,
  epKey,
  parseGuids,
  type ShowAirTimes,
  type AirSource,
} from './airtimes.ts';

/* ------------------------------------------------------------- migrations */

for (const sql of [
  'ALTER TABLE episodes ADD COLUMN air_stamp TEXT',
  "ALTER TABLE episodes ADD COLUMN air_source TEXT NOT NULL DEFAULT 'plex'",
]) {
  try {
    db.exec(sql);
  } catch {
    // Column already present.
  }
}

const DISCOVER = 'https://discover.provider.plex.tv';
const GAP_MS = 200;
/** Workers sharing the show queue. Four is brisk without being rude. */
const WORKERS = 4;

export interface EpisodeRow {
  rating_key: string;
  show_key: string;
  show_title: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  /** The Sydney calendar date. See src/airtimes.ts for how it is arrived at. */
  air_date: string | null;
  /** The instant behind that date, when a real one was available. */
  air_stamp: string | null;
  air_source: AirSource;
  thumb: string | null;
  first_seen_at: string;
  dismissed: number;
}

interface RawChild {
  ratingKey?: string;
  title?: string;
  index?: number;
  parentIndex?: number;
  originallyAvailableAt?: string;
  thumb?: string;
  leafCount?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function children(token: string, ratingKey: string): Promise<RawChild[]> {
  const res = await fetch(`${DISCOVER}/library/metadata/${ratingKey}/children`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Product': 'Plex Media Tracker',
      'X-Plex-Client-Identifier': 'plex-media-tracker',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`plex.tv returned HTTP ${res.status}`);
  const data = (await res.json()) as { MediaContainer?: { Metadata?: RawChild[] } };
  return data.MediaContainer?.Metadata ?? [];
}

function upsert(row: {
  rating_key: string;
  show_key: string;
  show_title: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  air_date: string | null;
  air_stamp: string | null;
  air_source: AirSource;
  thumb: string | null;
}): boolean {
  const existing = db.prepare('SELECT rating_key FROM episodes WHERE rating_key = ?').get(
    row.rating_key,
  );
  if (existing) {
    db.prepare(
      `UPDATE episodes SET show_title = ?, season = ?, episode = ?, title = ?, air_date = ?,
              air_stamp = ?, air_source = ?, thumb = ?
       WHERE rating_key = ?`,
    ).run(
      row.show_title,
      row.season,
      row.episode,
      row.title,
      row.air_date,
      row.air_stamp,
      row.air_source,
      row.thumb,
      row.rating_key,
    );
    return false;
  }
  db.prepare(
    `INSERT INTO episodes
       (rating_key, show_key, show_title, season, episode, title, air_date, air_stamp,
        air_source, thumb, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.rating_key,
    row.show_key,
    row.show_title,
    row.season,
    row.episode,
    row.title,
    row.air_date,
    row.air_stamp,
    row.air_source,
    row.thumb,
    nowIso(),
  );
  return true;
}

/* --------------------------------------------------- real air times */

/**
 * How long "TVMaze does not carry this show" stands before asking again.
 * TVMaze does add shows, so the answer is not permanent, but it changes slowly
 * enough that asking on every refresh would be waste.
 */
const ABSENT_RECHECK_DAYS = 30;

/** A show's external ids, which Plex only returns on the show itself. */
async function showGuids(token: string, ratingKey: string): Promise<Record<string, string>> {
  const res = await fetch(`${DISCOVER}/library/metadata/${ratingKey}`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Product': 'Plex Media Tracker',
      'X-Plex-Client-Identifier': 'plex-media-tracker',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`plex.tv returned HTTP ${res.status}`);
  const data = (await res.json()) as {
    MediaContainer?: { Metadata?: { Guid?: { id?: string }[] }[] };
  };
  return parseGuids(data.MediaContainer?.Metadata?.[0]?.Guid);
}

function remember(showKey: string, times: ShowAirTimes): void {
  db.prepare(
    `INSERT INTO show_air_sources (show_key, tvmaze_id, state, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(show_key) DO UPDATE SET
       tvmaze_id = excluded.tvmaze_id, state = excluded.state, checked_at = excluded.checked_at`,
  ).run(showKey, times.tvmazeId, times.lookup, nowIso());
}

/**
 * Air stamps for one show, going through the cache.
 *
 * A show already matched costs one TVMaze request and no Plex request at all,
 * because its TVMaze id is remembered. Only a show seen for the first time,
 * or one whose absence has gone stale, pays for the id lookup.
 */
async function airTimesFor(token: string, showKey: string): Promise<ShowAirTimes> {
  const empty = new Map<string, string>();
  try {
    const cached = db
      .prepare('SELECT tvmaze_id, state, checked_at FROM show_air_sources WHERE show_key = ?')
      .get(showKey) as { tvmaze_id: number | null; state: string; checked_at: string } | undefined;

    if (cached?.state === 'matched' && cached.tvmaze_id !== null) {
      return await showAirTimes({}, cached.tvmaze_id);
    }
    if (cached?.state === 'absent') {
      const age = Date.now() - new Date(cached.checked_at).getTime();
      if (age < ABSENT_RECHECK_DAYS * 86_400_000) {
        return { lookup: 'absent', tvmazeId: null, stamps: empty };
      }
    }

    const ids = await showGuids(token, showKey);
    await sleep(GAP_MS);
    const times = await showAirTimes(ids);
    // An unreachable TVMaze is not an answer, so it is not worth remembering.
    if (times.lookup !== 'unknown') remember(showKey, times);
    return times;
  } catch {
    // Plex or TVMaze out of reach. Plex's own dates stand rather than being
    // shifted on no evidence.
    return { lookup: 'unknown', tvmazeId: null, stamps: empty };
  }
}

export interface EpisodeSyncResult {
  shows: number;
  episodes: number;
  added: number;
  failed: number;
  /** Episodes whose Sydney date came from a real air time rather than a guess. */
  timed: number;
  /** Shows left alone because a recent walk saw nothing new. */
  skipped: number;
}

/* ------------------------------------------------------- walk bookkeeping */

/**
 * How long a walk stands. Walking every continuing show on every refresh was
 * the slowest part by far, four requests a show, and a show's schedule does
 * not change by the hour. Within the gap a show is only rewalked when the
 * watchlist says its last episode date moved.
 */
export const WALK_GAP_MS = 12 * 3_600_000;

export interface ShowWalk {
  walked_at: string;
  last_episode_at: string | null;
}

export function showDueForWalk(
  walk: ShowWalk | undefined,
  lastEpisodeAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!walk) return true;
  if (walk.last_episode_at !== lastEpisodeAt) return true;
  const age = now - Date.parse(walk.walked_at);
  return Number.isNaN(age) || age < 0 || age > WALK_GAP_MS;
}

export function lastWalk(showKey: string): ShowWalk | undefined {
  const row = db
    .prepare('SELECT walked_at, last_episode_at FROM show_walks WHERE show_key = ?')
    .get(showKey) as ShowWalk | undefined;
  return row ? { walked_at: row.walked_at, last_episode_at: row.last_episode_at } : undefined;
}

export function recordWalk(showKey: string, lastEpisodeAt: string | null, at: string = nowIso()): void {
  db.prepare(
    `INSERT INTO show_walks (show_key, walked_at, last_episode_at) VALUES (?, ?, ?)
     ON CONFLICT(show_key) DO UPDATE SET
       walked_at = excluded.walked_at, last_episode_at = excluded.last_episode_at`,
  ).run(showKey, at, lastEpisodeAt);
}

/**
 * Only continuing shows are walked. A finished series cannot gain an episode,
 * so spending two requests on it every refresh would be waste.
 */
export async function syncEpisodes(
  onProgress?: (m: string) => void,
  force = false,
): Promise<EpisodeSyncResult> {
  const token = store.getSetting('plex_token');
  const result: EpisodeSyncResult = {
    shows: 0,
    episodes: 0,
    added: 0,
    failed: 0,
    timed: 0,
    skipped: 0,
  };
  if (!token) return result;

  const listed = db
    .prepare(
      `SELECT rating_key, title, last_episode_at FROM watchlist_items
       WHERE type = 'show' AND state = 'listed' AND continuing = 1
       ORDER BY last_episode_at DESC`,
    )
    .all() as { rating_key: string; title: string; last_episode_at: string | null }[];

  // A pressed button means a real check; a start-up refresh only walks what
  // could have changed.
  const shows = listed.filter((s) => {
    if (force || showDueForWalk(lastWalk(s.rating_key), s.last_episode_at)) return true;
    result.skipped += 1;
    return false;
  });

  // Two requests per show, serialised, was the slowest part of a refresh by a
  // wide margin. A handful of workers share the queue, each keeping its own
  // gap, which cuts the wall clock without hammering plex.tv.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= shows.length) return;
      const show = shows[i]!;
      onProgress?.(`Episode schedules, ${Math.min(next, shows.length)} of ${shows.length}: ${show.title}`);
      try {
        const air = await airTimesFor(token, show.rating_key);
        await sleep(GAP_MS);

        const seasons = (await children(token, show.rating_key)).filter(
          (s) => typeof s.index === 'number' && s.index > 0,
        );
        await sleep(GAP_MS);

        // The two newest seasons cover both the current run and a recent finale.
        for (const season of seasons.slice(-2)) {
          if (!season.ratingKey) continue;
          const eps = await children(token, season.ratingKey);
          await sleep(GAP_MS);
          for (const ep of eps) {
            if (!ep.ratingKey) continue;
            const seasonNo =
              typeof ep.parentIndex === 'number' ? ep.parentIndex : (season.index ?? null);
            const episodeNo = typeof ep.index === 'number' ? ep.index : null;

            // Plex's date is the show's own country. What Sydney gets, and
            // when, is worked out in src/airtimes.ts.
            const plexDate = /^\d{4}-\d{2}-\d{2}$/.test(ep.originallyAvailableAt ?? '')
              ? ep.originallyAvailableAt!
              : null;
            const key = epKey(seasonNo, episodeNo);
            const when = resolveAir(plexDate, key ? air.stamps.get(key) : undefined, air.lookup);

            const isNew = upsert({
              rating_key: String(ep.ratingKey),
              show_key: show.rating_key,
              show_title: show.title,
              season: seasonNo,
              episode: episodeNo,
              title: ep.title && ep.title !== 'TBA' ? ep.title : null,
              air_date: when.air_date,
              air_stamp: when.air_stamp,
              air_source: when.air_source,
              thumb: ep.thumb ?? null,
            });
            result.episodes += 1;
            if (isNew) result.added += 1;
            if (when.air_source === 'tvmaze') result.timed += 1;
          }
        }
        result.shows += 1;
        recordWalk(show.rating_key, show.last_episode_at);
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));

  // Episodes of shows no longer on the watchlist are not worth keeping.
  for (const table of ['episodes', 'show_air_sources', 'show_walks']) {
    db.exec(
      `DELETE FROM ${table} WHERE show_key NOT IN
         (SELECT rating_key FROM watchlist_items WHERE state = 'listed')`,
    );
  }
  return result;
}

/* ------------------------------------------------------------------ feed */

export interface EpisodeFeedRow {
  kind: 'show';
  id: string;
  title: string;
  subtitle: string;
  date: string | null;
  /**
   * The exact instant it lands, when a real one is known. The date above is
   * this stamp read in Sydney, so a row carrying one can be shown to the
   * minute and a row without one only ever to the day.
   */
  air_stamp: string | null;
  event: string;
  show_key: string;
  first_seen_at: string;
  dismissed: number;
  /** 1 when this exact episode is already on the server, not just the series. */
  in_library: number;
  /** The local key for the held episode, for a deep link into Plex. */
  plex_rating_key: string | null;
}

function label(r: EpisodeRow): string {
  const num =
    r.season !== null && r.episode !== null
      ? `S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`
      : 'episode';
  return r.title ? `${num} · ${r.title}` : num;
}

/** The run of episodes held for one season of a show. */
export interface SeasonSpan {
  first: number;
  last: number;
  count: number;
}

export interface ShowShape {
  /** Season number to what is held for it. */
  seasons: Map<number, SeasonSpan>;
  /** True when Plex has stopped calling the series continuing. */
  ended: boolean;
}

/**
 * What a row is worth calling: a premiere, a finale, or just another episode.
 *
 * A finale is only claimed when the whole season is listed, first episode
 * through to last with no gaps. Plex announces a season in pieces, so without
 * that check the newest row announced would be badged the finale every week,
 * and the badge would walk down the season as more of it appeared.
 *
 * Whether a series is over is Plex's "continuing" flag, which it clears once a
 * show has finished. A show resting between seasons keeps the flag, so a
 * series finale is only claimed on the last season held for an ended show.
 */
export function episodeEvent(
  season: number | null,
  episode: number | null,
  shape: ShowShape | undefined,
): string {
  if (season === null || episode === null) return 'episode';
  if (episode === 1) return season === 1 ? 'series premiere' : 'season premiere';
  if (!shape) return 'episode';

  const span = shape.seasons.get(season);
  if (!span || span.first !== 1 || span.count !== span.last || episode !== span.last) {
    return 'episode';
  }
  const newest = Math.max(...shape.seasons.keys());
  return shape.ended && season === newest ? 'series finale' : 'season finale';
}

/** Season runs for every show with episodes held, for the labels above. */
function showShapes(): Map<string, ShowShape> {
  const ended = new Set(
    (
      db
        .prepare("SELECT rating_key FROM watchlist_items WHERE type = 'show' AND continuing = 0")
        .all() as { rating_key: string }[]
    ).map((r) => r.rating_key),
  );

  const rows = db
    .prepare(
      `SELECT show_key, season,
              MIN(episode) AS first, MAX(episode) AS last, COUNT(DISTINCT episode) AS held
       FROM episodes
       WHERE season IS NOT NULL AND episode IS NOT NULL
       GROUP BY show_key, season`,
    )
    .all() as unknown as {
    show_key: string;
    season: number;
    first: number;
    last: number;
    held: number;
  }[];

  const shapes = new Map<string, ShowShape>();
  for (const r of rows) {
    let shape = shapes.get(r.show_key);
    if (!shape) {
      shape = { seasons: new Map(), ended: ended.has(r.show_key) };
      shapes.set(r.show_key, shape);
    }
    shape.seasons.set(Number(r.season), {
      first: Number(r.first),
      last: Number(r.last),
      count: Number(r.held),
    });
  }
  return shapes;
}

export function episodeFeed(
  kind: 'out' | 'upcoming' | 'dismissed',
  recentDays: number,
): EpisodeFeedRow[] {
  const now = today();
  const since = daysAgo(recentDays);

  let sql = `SELECT e.*,
                    EXISTS (SELECT 1 FROM local_episodes le
                            WHERE le.show_guid = w.guid
                              AND le.season = e.season
                              AND le.episode = e.episode) AS held,
                    (SELECT le2.rating_key FROM local_episodes le2
                     WHERE le2.show_guid = w.guid AND le2.season = e.season
                       AND le2.episode = e.episode) AS local_key
             FROM episodes e
             JOIN watchlist_items w ON w.rating_key = e.show_key
             WHERE w.state = 'listed' AND e.air_date IS NOT NULL`;
  const params: string[] = [];

  if (kind === 'upcoming') {
    sql += ' AND e.dismissed = 0 AND e.air_date > ? ORDER BY e.air_date ASC';
    params.push(now);
  } else if (kind === 'dismissed') {
    sql += ' AND e.dismissed = 1 ORDER BY e.air_date DESC';
  } else {
    sql += ' AND e.dismissed = 0 AND e.air_date <= ? AND e.air_date >= ? ORDER BY e.air_date DESC';
    params.push(now, since);
  }

  const rows = db.prepare(sql).all(...params) as unknown as (EpisodeRow & {
    held: number;
    local_key: string | null;
  })[];
  const shapes = showShapes();
  return rows.map((r) => ({
    kind: 'show' as const,
    id: r.rating_key,
    title: r.show_title,
    subtitle: label(r),
    date: r.air_date,
    air_stamp: r.air_source === 'tvmaze' ? r.air_stamp : null,
    event: episodeEvent(r.season, r.episode, shapes.get(r.show_key)),
    show_key: r.show_key,
    first_seen_at: r.first_seen_at,
    dismissed: r.dismissed,
    in_library: r.held ? 1 : 0,
    plex_rating_key: r.local_key,
  }));
}

/** Shows that have episode rows, so the show-level entry can stand aside. */
export function showsWithEpisodes(): Set<string> {
  const rows = db.prepare('SELECT DISTINCT show_key FROM episodes').all() as {
    show_key: string;
  }[];
  return new Set(rows.map((r) => r.show_key));
}

export function dismissEpisode(ratingKey: string, dismissed: boolean): void {
  db.prepare('UPDATE episodes SET dismissed = ? WHERE rating_key = ?').run(
    dismissed ? 1 : 0,
    ratingKey,
  );
}


/* ------------------------------------------------- what the server holds */

interface LocalEpisode {
  grandparentGuid?: string;
  parentIndex?: number;
  index?: number;
  ratingKey?: string;
  title?: string;
  Media?: { videoResolution?: string }[];
}

/**
 * Every episode actually on the local server, so a tick can mean "I have this
 * episode" rather than the far weaker "I have this series". The whole TV
 * section comes back in a handful of paged requests over the LAN.
 */
export async function syncLocalEpisodes(
  baseUrl: string,
  token: string,
  sectionKeys: string[],
  onProgress?: (m: string) => void,
): Promise<number> {
  const rows: {
    guid: string;
    season: number;
    episode: number;
    rating_key: string | null;
    title: string | null;
    file_count: number;
    resolution: string | null;
  }[] = [];

  for (const key of sectionKeys) {
    let start = 0;
    for (;;) {
      onProgress?.(`Reading episodes already on the server (${rows.length})`);
      const url =
        `${baseUrl.replace(/\/+$/, '')}/library/sections/${key}/all?type=4&includeGuids=1` +
        `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=500&X-Plex-Token=${token}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Plex returned HTTP ${res.status}`);
      const data = (await res.json()) as { MediaContainer?: { Metadata?: LocalEpisode[] } };
      const batch = data.MediaContainer?.Metadata ?? [];
      for (const e of batch) {
        if (!e.grandparentGuid || typeof e.parentIndex !== 'number' || typeof e.index !== 'number') {
          continue;
        }
        const media = e.Media ?? [];
        rows.push({
          guid: e.grandparentGuid,
          season: e.parentIndex,
          episode: e.index,
          rating_key: e.ratingKey ? String(e.ratingKey) : null,
          title: e.title ?? null,
          file_count: media.length,
          resolution: media[0]?.videoResolution ?? null,
        });
      }
      if (batch.length < 500) break;
      start += batch.length;
      if (start > 200_000) break; // sanity cap
    }
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM local_episodes');
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO local_episodes
         (show_guid, season, episode, rating_key, title, file_count, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(r.guid, r.season, r.episode, r.rating_key, r.title, r.file_count, r.resolution);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}
