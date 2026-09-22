/**
 * Storage for the Plex Watchlist. Kept apart from db.ts so neither file has to
 * hold both the music schema and this one in one head.
 */
import { db } from './db.ts';
import { today, daysAgo, nowIso } from './dates.ts';
import { showsWithEpisodes } from './episodes.ts';

// Lightweight migration: databases made before the gap list have no year.
try {
  db.exec('ALTER TABLE library_guids ADD COLUMN year INTEGER');
} catch {
  // Already there.
}
import { allFilmDates } from './tmdb.ts';
import type { LibraryEntry } from './plex.ts';

export type WlState = 'listed' | 'removed';

export interface WatchlistRow {
  rating_key: string;
  guid: string;
  type: 'movie' | 'show';
  title: string;
  year: number | null;
  thumb: string | null;
  release_date: string | null;
  last_episode_at: string | null;
  last_season_at: string | null;
  season_count: number | null;
  episode_count: number | null;
  continuing: number;
  public_url: string | null;
  added_at: string | null;
  in_library: number;
  state: WlState;
  baseline: WlState;
  new_event: string | null;
  new_event_at: string | null;
  first_seen_at: string;
  dismissed: number;
}

export interface NewItem {
  rating_key: string;
  guid: string;
  type: string;
  title: string;
  year: number | null;
  thumb: string | null;
  release_date: string | null;
  last_episode_at: string | null;
  last_season_at: string | null;
  season_count: number | null;
  episode_count: number | null;
  continuing: boolean;
  public_url: string | null;
  added_at: string | null;
}

export function watchlistCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM watchlist_items').get() as { n: number }).n;
}

export function allWatchlistRows(): WatchlistRow[] {
  return db
    .prepare('SELECT * FROM watchlist_items ORDER BY title COLLATE NOCASE')
    .all() as unknown as WatchlistRow[];
}

export function getWatchlistRow(ratingKey: string): WatchlistRow | undefined {
  const row = db.prepare('SELECT * FROM watchlist_items WHERE rating_key = ?').get(ratingKey);
  return row as unknown as WatchlistRow | undefined;
}

export function insertWatchlistItem(item: NewItem): void {
  db.prepare(
    `INSERT INTO watchlist_items
       (rating_key, guid, type, title, year, thumb, release_date, last_episode_at,
        last_season_at, season_count, episode_count, continuing, public_url, added_at,
        state, baseline, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed', 'listed', ?)`,
  ).run(
    item.rating_key,
    item.guid,
    item.type,
    item.title,
    item.year,
    item.thumb,
    item.release_date,
    item.last_episode_at,
    item.last_season_at,
    item.season_count,
    item.episode_count,
    item.continuing ? 1 : 0,
    item.public_url,
    item.added_at,
    nowIso(),
  );
}

/** Refreshes metadata. An event is recorded when a show's dates move forward. */
export function refreshWatchlistItem(
  ratingKey: string,
  next: NewItem,
  event: { kind: string; at: string } | null,
): void {
  db.prepare(
    `UPDATE watchlist_items SET
       title = ?, year = ?, thumb = ?, release_date = ?, last_episode_at = ?,
       last_season_at = ?, season_count = ?, episode_count = ?, continuing = ?,
       public_url = ?,
       new_event    = COALESCE(?, new_event),
       new_event_at = COALESCE(?, new_event_at)
     WHERE rating_key = ?`,
  ).run(
    next.title,
    next.year,
    next.thumb,
    next.release_date,
    next.last_episode_at,
    next.last_season_at,
    next.season_count,
    next.episode_count,
    next.continuing ? 1 : 0,
    next.public_url,
    event?.kind ?? null,
    event?.at ?? null,
    ratingKey,
  );
}

export function setWatchlistState(ratingKey: string, state: WlState, baseline: WlState): void {
  db.prepare('UPDATE watchlist_items SET state = ?, baseline = ? WHERE rating_key = ?').run(
    state,
    baseline,
    ratingKey,
  );
}

export function dismissWatchlistItem(ratingKey: string, dismissed: boolean): void {
  db.prepare('UPDATE watchlist_items SET dismissed = ? WHERE rating_key = ?').run(
    dismissed ? 1 : 0,
    ratingKey,
  );
}

/* ---------------------------------------------------------- removal log */

export interface RemovalRow {
  id: number;
  rating_key: string;
  title: string;
  year: number | null;
  type: string;
  source: string;
  removed_at: string;
  restored_at: string | null;
}

/** Every removal is logged with enough detail to put the item back. */
export function logRemoval(row: WatchlistRow, source: 'app' | 'plex'): void {
  db.prepare(
    `INSERT INTO watchlist_removals (rating_key, title, year, type, source, removed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.rating_key, row.title, row.year, row.type, source, nowIso());
}

export function recentRemovals(limit = 50): RemovalRow[] {
  return db
    .prepare('SELECT * FROM watchlist_removals WHERE restored_at IS NULL ORDER BY id DESC LIMIT ?')
    .all(limit) as unknown as RemovalRow[];
}

export function markRemovalRestored(ratingKey: string): void {
  db.prepare(
    'UPDATE watchlist_removals SET restored_at = ? WHERE rating_key = ? AND restored_at IS NULL',
  ).run(nowIso(), ratingKey);
}

/* --------------------------------------------------------- library guids */

export function replaceLibraryGuids(rows: LibraryEntry[]): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM library_guids');
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO library_guids
         (guid, rating_key, type, title, year, file_count, resolution, codec, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(
        r.guid,
        r.rating_key,
        r.type,
        r.title,
        r.year,
        r.file_count,
        r.resolution,
        r.codec,
        r.size,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Flags every watchlist item whose GUID is already held on the server. */
export function refreshInLibraryFlags(): number {
  db.exec('UPDATE watchlist_items SET in_library = 0');
  db.exec(
    'UPDATE watchlist_items SET in_library = 1 WHERE guid IN (SELECT guid FROM library_guids)',
  );
  return (
    db.prepare('SELECT COUNT(*) AS n FROM watchlist_items WHERE in_library = 1').get() as {
      n: number;
    }
  ).n;
}

/* ----------------------------------------------------------------- feed */

export interface WatchlistFeedRow {
  kind: 'movie' | 'show';
  id: string;
  title: string;
  subtitle: string;
  date: string | null;
  event: string | null;
  in_library: number;
  public_url: string | null;
  first_seen_at: string;
  dismissed: number;
  /** 'digital', 'cinema', or null when only Plex's single date is known. */
  date_kind: string | null;
  /** The local server's key for this thing, when it holds it. */
  plex_rating_key: string | null;
}

/**
 * Films drop off the list once they are on the server. Shows do not, because
 * episodes keep arriving long after the series itself is held locally.
 */
export function watchlistFeed(
  kind: 'out' | 'upcoming' | 'dismissed',
  recentDays: number,
): WatchlistFeedRow[] {
  const now = today();
  const since = daysAgo(recentDays);
  const rows = db
    .prepare("SELECT * FROM watchlist_items WHERE state = 'listed'")
    .all() as unknown as WatchlistRow[];
  // Where individual episodes are known, they replace the vaguer show-level
  // "something aired" entry rather than sitting alongside it.
  const detailed = showsWithEpisodes();
  const filmDates = allFilmDates();
  const localKeys = new Map(
    (db.prepare('SELECT guid, rating_key FROM library_guids WHERE rating_key IS NOT NULL').all() as {
      guid: string;
      rating_key: string;
    }[]).map((r) => [r.guid, r.rating_key]),
  );

  const out: WatchlistFeedRow[] = [];
  for (const r of rows) {
    if (r.type === 'show' && detailed.has(r.rating_key)) continue;
    const wantDismissed = kind === 'dismissed';
    if (wantDismissed !== (r.dismissed === 1)) continue;

    const premiere = r.release_date;
    const notYetOut = premiere !== null && premiere > now;

    if (kind === 'upcoming') {
      if (r.type === 'movie') {
        const f = filmDates.get(r.rating_key);
        const when = f?.digital_date ?? premiere;
        if (!when || when <= now) continue;
        out.push(shape(r, when, null, f?.digital_date ? 'digital' : 'cinema', localKeys));
        continue;
      }
      if (!notYetOut) continue;
      out.push(shape(r, premiere, 'premiere', null, localKeys));
      continue;
    }

    if (notYetOut) continue;

    if (r.type === 'show') {
      const when = r.last_episode_at;
      if (!when || when < since || when > now) continue;
      const newSeason = r.last_season_at !== null && r.last_season_at >= since;
      out.push(shape(r, when, newSeason ? 'new season' : 'new episode', null, localKeys));
    } else {
      const f = filmDates.get(r.rating_key);
      const when = f?.digital_date ?? premiere;
      const dateKind = f?.digital_date ? 'digital' : f?.cinema_date || premiere ? 'cinema' : null;
      if (!when || when < since || when > now) continue;
      out.push(shape(r, when, null, dateKind, localKeys));
    }
  }
  return out;
}

function shape(
  r: WatchlistRow,
  date: string | null,
  event: string | null,
  dateKind: string | null = null,
  localKeys: Map<string, string> = new Map(),
): WatchlistFeedRow {
  const bits: string[] = [];
  if (r.year) bits.push(String(r.year));
  if (r.type === 'show' && r.season_count) {
    bits.push(`${r.season_count} ${r.season_count === 1 ? 'season' : 'seasons'}`);
  }
  return {
    kind: r.type,
    id: r.rating_key,
    title: r.title,
    subtitle: bits.join(' · '),
    date,
    event,
    in_library: r.in_library,
    public_url: r.public_url,
    first_seen_at: r.first_seen_at,
    dismissed: r.dismissed,
    date_kind: dateKind,
    plex_rating_key: localKeys.get(r.guid) ?? null,
  };
}

/**
 * What the Out now badge counts: things there are still for you to get.
 *
 * Anything already on the server is out, and so is a film that has only opened
 * in cinemas, because you cannot watch it at home yet. The tab hides cinema
 * films by default for the same reason, and the badge used to count them
 * anyway, which is part of why the two never agreed.
 */
export function countableForBadge(r: { in_library: number; date_kind: string | null }): boolean {
  return r.in_library !== 1 && r.date_kind !== 'cinema';
}

export function watchlistCounts(recentDays: number): { out: number; upcoming: number; listed: number } {
  return {
    out: watchlistFeed('out', recentDays).filter(countableForBadge).length,
    upcoming: watchlistFeed('upcoming', recentDays).length,
    listed: (
      db.prepare("SELECT COUNT(*) AS n FROM watchlist_items WHERE state = 'listed'").get() as {
        n: number;
      }
    ).n,
  };
}


/* ------------------------------------------------- library, not watchlisted */

export interface GapRow {
  /** The Discover rating key, which is the tail of the plex:// guid. */
  rating_key: string;
  guid: string;
  title: string;
  year: number | null;
}

/**
 * Shows sitting on the server that are not on the watchlist. Adding one starts
 * episode tracking, which is the only way to know a new episode is coming.
 */
export function libraryShowGaps(): GapRow[] {
  const rows = db
    .prepare(
      `SELECT g.guid, g.title, g.year FROM library_guids g
       WHERE g.type = 'show'
         AND g.guid NOT IN (SELECT guid FROM watchlist_items WHERE state = 'listed')
       ORDER BY g.title COLLATE NOCASE`,
    )
    .all() as { guid: string; title: string; year: number | null }[];

  return rows
    .map((r) => ({
      rating_key: r.guid.replace(/^plex:\/\/show\//, ''),
      guid: r.guid,
      title: r.title,
      year: r.year,
    }))
    .filter((r) => r.rating_key !== r.guid);
}
