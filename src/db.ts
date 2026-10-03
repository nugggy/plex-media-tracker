import { openDatabase } from './sqlite-driver.ts';
import type { Db } from './sqlite.ts';
import { PLATFORM } from './config.ts';
import { today, daysAgo, nowIso } from './dates.ts';

export type MbStatus = 'pending' | 'resolved' | 'ambiguous' | 'not_found' | 'manual' | 'error';

export interface ArtistRow {
  plex_key: string;
  name: string;
  sort_name: string;
  thumb: string | null;
  mbid: string | null;
  mb_status: MbStatus;
  mb_candidates: string | null;
  muted: number;
  album_count: number;
  last_checked_at: string | null;
  last_error: string | null;
  present: number;
}

export interface ReleaseRow {
  mb_id: string;
  plex_key: string;
  title: string;
  norm_title: string;
  primary_type: string | null;
  secondary_types: string | null;
  release_date: string | null;
  owned: number;
  first_seen_at: string;
  dismissed: number;
}

export interface MbCandidate {
  id: string;
  name: string;
  score: number;
  disambiguation: string;
  area: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artists (
  plex_key        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sort_name       TEXT NOT NULL DEFAULT '',
  thumb           TEXT,
  mbid            TEXT,
  mb_status       TEXT NOT NULL DEFAULT 'pending',
  mb_candidates   TEXT,
  muted           INTEGER NOT NULL DEFAULT 0,
  album_count     INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_error      TEXT,
  present         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS plex_albums (
  plex_key   TEXT PRIMARY KEY,
  artist_key TEXT NOT NULL,
  title      TEXT NOT NULL,
  norm_title TEXT NOT NULL,
  year       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON plex_albums(artist_key);
CREATE INDEX IF NOT EXISTS idx_albums_norm   ON plex_albums(artist_key, norm_title);

CREATE TABLE IF NOT EXISTS releases (
  mb_id           TEXT PRIMARY KEY,
  plex_key        TEXT NOT NULL,
  title           TEXT NOT NULL,
  norm_title      TEXT NOT NULL,
  primary_type    TEXT,
  secondary_types TEXT,
  release_date    TEXT,
  owned           INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL,
  dismissed       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_releases_artist ON releases(plex_key);
CREATE INDEX IF NOT EXISTS idx_releases_date   ON releases(release_date);

CREATE TABLE IF NOT EXISTS watchlist_items (
  rating_key      TEXT PRIMARY KEY,
  guid            TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  year            INTEGER,
  thumb           TEXT,
  release_date    TEXT,
  last_episode_at TEXT,
  last_season_at  TEXT,
  season_count    INTEGER,
  episode_count   INTEGER,
  continuing      INTEGER NOT NULL DEFAULT 0,
  public_url      TEXT,
  added_at        TEXT,
  in_library      INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'listed',
  baseline        TEXT NOT NULL DEFAULT 'listed',
  new_event       TEXT,
  new_event_at    TEXT,
  first_seen_at   TEXT NOT NULL,
  dismissed       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wl_state ON watchlist_items(state);
CREATE INDEX IF NOT EXISTS idx_wl_guid  ON watchlist_items(guid);

CREATE TABLE IF NOT EXISTS watchlist_removals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rating_key  TEXT NOT NULL,
  title       TEXT NOT NULL,
  year        INTEGER,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL,
  removed_at  TEXT NOT NULL,
  restored_at TEXT
);

CREATE TABLE IF NOT EXISTS local_episodes (
  show_guid TEXT NOT NULL,
  season    INTEGER NOT NULL,
  episode   INTEGER NOT NULL,
  PRIMARY KEY (show_guid, season, episode)
);

CREATE TABLE IF NOT EXISTS library_guids (
  guid  TEXT PRIMARY KEY,
  type  TEXT NOT NULL,
  title TEXT,
  year  INTEGER
);

CREATE TABLE IF NOT EXISTS episodes (
  rating_key    TEXT PRIMARY KEY,
  show_key      TEXT NOT NULL,
  show_title    TEXT NOT NULL,
  season        INTEGER,
  episode       INTEGER,
  title         TEXT,
  air_date      TEXT,
  thumb         TEXT,
  first_seen_at TEXT NOT NULL,
  dismissed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ep_show ON episodes(show_key);
CREATE INDEX IF NOT EXISTS idx_ep_date ON episodes(air_date);

-- Which show is which on TVMaze, so the lookup behind an episode's real air
-- time is paid once rather than on every refresh. A show TVMaze does not carry
-- is recorded as absent and only asked about again much later.
CREATE TABLE IF NOT EXISTS show_air_sources (
  show_key   TEXT PRIMARY KEY,
  tvmaze_id  INTEGER,
  state      TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

-- When each continuing show's episodes were last walked, and the last episode
-- date the watchlist showed at the time. A show walked recently whose date
-- has not moved is left alone on the next refresh.
CREATE TABLE IF NOT EXISTS show_walks (
  show_key        TEXT PRIMARY KEY,
  walked_at       TEXT NOT NULL,
  last_episode_at TEXT
);

CREATE TABLE IF NOT EXISTS youtube_cache (
  query      TEXT PRIMARY KEY,
  video_id   TEXT,
  looked_up  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  artists_seen INTEGER NOT NULL DEFAULT 0,
  new_releases INTEGER NOT NULL DEFAULT 0,
  message      TEXT
);
`;

export const db: Db = openDatabase();
db.exec(SCHEMA);

/* ---------------------------------------------------------------- settings */

const DEFAULTS: Record<string, string> = {
  plex_url: '',
  plex_token: '',
  /** 'manual' uses plex_url as typed; 'auto' finds the server via plex.tv each check. */
  // A typed LAN address is no use to a phone away from home.
  plex_connection: PLATFORM === 'mobile' ? 'auto' : 'manual',
  /** local, remote or relay: how the last automatic lookup reached the server. */
  plex_connection_kind: '',
  plex_section: '',
  plex_section_title: '',
  recent_days: '180',
  stale_days: '7',
  include_album: '1',
  include_ep: '1',
  include_single: '1',
  include_movie: '1',
  include_show: '1',
  watchlist_enabled: '1',
  sync_on_start: '1',
  /** When the last full quick refresh finished cleanly. A start within two hours of it skips its own. */
  last_refresh_at: '',
  tmdb_api_key: '',
  plex_machine_id: '',
  plex_video_sections: '',
};

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

export function getSettings(): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULTS };
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function isConfigured(): boolean {
  // Automatic mode finds its address at the start of each check, so a server
  // picked but not yet reached still counts as set up.
  const reachable =
    Boolean(getSetting('plex_url')) ||
    (getSetting('plex_connection') === 'auto' && Boolean(getSetting('plex_machine_id')));
  return reachable && Boolean(getSetting('plex_token') && getSetting('plex_section'));
}

/* ----------------------------------------------------------------- artists */

export function upsertArtist(a: {
  plex_key: string;
  name: string;
  sort_name: string;
  thumb: string | null;
  album_count: number;
  mbid: string | null;
}): void {
  // An mbid the user set by hand is never overwritten by a later scan.
  db.prepare(
    `INSERT INTO artists (plex_key, name, sort_name, thumb, album_count, mbid, mb_status, present)
     VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN 'pending' ELSE 'resolved' END, 1)
     ON CONFLICT(plex_key) DO UPDATE SET
       name        = excluded.name,
       sort_name   = excluded.sort_name,
       thumb       = excluded.thumb,
       album_count = excluded.album_count,
       present     = 1,
       mbid        = CASE WHEN artists.mb_status = 'manual' THEN artists.mbid
                          ELSE COALESCE(artists.mbid, excluded.mbid) END,
       mb_status   = CASE WHEN artists.mb_status = 'manual'   THEN 'manual'
                          WHEN artists.mbid IS NOT NULL       THEN artists.mb_status
                          WHEN excluded.mbid IS NOT NULL      THEN 'resolved'
                          ELSE artists.mb_status END`,
  ).run(a.plex_key, a.name, a.sort_name, a.thumb, a.album_count, a.mbid, a.mbid);
}

/**
 * Flags artists that are no longer in the Plex library so they drop out of
 * the feeds. A manually watched artist (Trending, Suggestions) has a
 * synthetic `manual:<mbid>` key that never appears in a Plex scan, since it
 * is not a Plex library artist at all; without this exemption a scan would
 * un-watch every one of them the moment it runs.
 */
export function markAbsentArtists(seenKeys: string[]): number {
  db.exec("UPDATE artists SET present = 0 WHERE plex_key NOT LIKE 'manual:%'");
  const chunkSize = 400;
  for (let i = 0; i < seenKeys.length; i += chunkSize) {
    const chunk = seenKeys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(`UPDATE artists SET present = 1 WHERE plex_key IN (${placeholders})`).run(...chunk);
  }
  const row = db.prepare('SELECT COUNT(*) AS n FROM artists WHERE present = 0').get() as {
    n: number;
  };
  return row.n;
}

export function setArtistMbid(plexKey: string, mbid: string | null, status: MbStatus): void {
  db.prepare(
    'UPDATE artists SET mbid = ?, mb_status = ?, mb_candidates = NULL, last_error = NULL WHERE plex_key = ?',
  ).run(mbid, status, plexKey);
}

export function setArtistCandidates(plexKey: string, candidates: MbCandidate[]): void {
  db.prepare("UPDATE artists SET mb_status = 'ambiguous', mb_candidates = ? WHERE plex_key = ?").run(
    JSON.stringify(candidates),
    plexKey,
  );
}

export function setArtistError(plexKey: string, message: string): void {
  db.prepare("UPDATE artists SET mb_status = 'error', last_error = ? WHERE plex_key = ?").run(
    message.slice(0, 500),
    plexKey,
  );
}

export function markArtistChecked(plexKey: string): void {
  db.prepare('UPDATE artists SET last_checked_at = ?, last_error = NULL WHERE plex_key = ?').run(
    nowIso(),
    plexKey,
  );
}

export function setArtistMuted(plexKey: string, muted: boolean): void {
  db.prepare('UPDATE artists SET muted = ? WHERE plex_key = ?').run(muted ? 1 : 0, plexKey);
}

export function artistsNeedingMbid(): ArtistRow[] {
  return db
    .prepare(
      `SELECT * FROM artists
       WHERE present = 1 AND muted = 0 AND mbid IS NULL
         AND mb_status IN ('pending', 'error')
       ORDER BY album_count DESC, sort_name COLLATE NOCASE`,
    )
    .all() as unknown as ArtistRow[];
}

export function artistsDueForCheck(staleDays: number): ArtistRow[] {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT * FROM artists
       WHERE present = 1 AND muted = 0 AND mbid IS NOT NULL
         AND (last_checked_at IS NULL OR last_checked_at < ?)
       ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC`,
    )
    .all(cutoff) as unknown as ArtistRow[];
}

export function allArtists(): ArtistRow[] {
  return db
    .prepare('SELECT * FROM artists WHERE present = 1 ORDER BY sort_name COLLATE NOCASE')
    .all() as unknown as ArtistRow[];
}

export function getArtist(plexKey: string): ArtistRow | undefined {
  const row = db.prepare('SELECT * FROM artists WHERE plex_key = ?').get(plexKey);
  return row as unknown as ArtistRow | undefined;
}

/* ------------------------------------------------------------- plex albums */

export interface PlexAlbumRow {
  plex_key: string;
  artist_key: string;
  title: string;
  norm_title: string;
  year: number | null;
}

export function replacePlexAlbums(rows: PlexAlbumRow[]): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM plex_albums');
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO plex_albums (plex_key, artist_key, title, norm_title, year) VALUES (?, ?, ?, ?, ?)',
    );
    for (const r of rows) stmt.run(r.plex_key, r.artist_key, r.title, r.norm_title, r.year);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The albums Plex holds for one artist, as last read. */
export function albumsOf(artistKey: string): PlexAlbumRow[] {
  return db
    .prepare('SELECT * FROM plex_albums WHERE artist_key = ? ORDER BY year, title COLLATE NOCASE')
    .all(artistKey) as unknown as PlexAlbumRow[];
}

export function ownedTitles(artistKey: string): Set<string> {
  const rows = db
    .prepare('SELECT norm_title FROM plex_albums WHERE artist_key = ?')
    .all(artistKey) as { norm_title: string }[];
  return new Set(rows.map((r) => r.norm_title));
}

/* ---------------------------------------------------------------- releases */

/** Returns true when this release group had not been recorded before. */
export function upsertRelease(r: {
  mb_id: string;
  plex_key: string;
  title: string;
  norm_title: string;
  primary_type: string | null;
  secondary_types: string | null;
  release_date: string | null;
  owned: boolean;
}): boolean {
  const existing = db.prepare('SELECT mb_id FROM releases WHERE mb_id = ?').get(r.mb_id);
  if (existing) {
    db.prepare(
      `UPDATE releases SET title = ?, norm_title = ?, primary_type = ?, secondary_types = ?,
                           release_date = ?, owned = ?, plex_key = ?
       WHERE mb_id = ?`,
    ).run(
      r.title,
      r.norm_title,
      r.primary_type,
      r.secondary_types,
      r.release_date,
      r.owned ? 1 : 0,
      r.plex_key,
      r.mb_id,
    );
    return false;
  }
  db.prepare(
    `INSERT INTO releases (mb_id, plex_key, title, norm_title, primary_type, secondary_types,
                           release_date, owned, first_seen_at, dismissed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    r.mb_id,
    r.plex_key,
    r.title,
    r.norm_title,
    r.primary_type,
    r.secondary_types,
    r.release_date,
    r.owned ? 1 : 0,
    nowIso(),
  );
  return true;
}

export function dismissRelease(mbId: string, dismissed: boolean): void {
  db.prepare('UPDATE releases SET dismissed = ? WHERE mb_id = ?').run(dismissed ? 1 : 0, mbId);
}

export interface FeedRow extends ReleaseRow {
  artist_name: string;
  thumb: string | null;
}

/** Filtering happens in the browser, so the feed hands over the whole list. */
const FEED_LIMIT = 2000;

const FEED_BASE = `SELECT r.*, a.name AS artist_name, a.thumb AS thumb
                   FROM releases r JOIN artists a ON a.plex_key = r.plex_key
                   WHERE a.muted = 0 AND a.present = 1
                     AND r.release_date IS NOT NULL`;

export function feed(kind: 'out' | 'upcoming' | 'dismissed', recentDays: number): FeedRow[] {
  const now = today();
  const since = daysAgo(recentDays);

  if (kind === 'dismissed') {
    return db
      .prepare(`${FEED_BASE} AND r.dismissed = 1 ORDER BY r.release_date DESC LIMIT ${FEED_LIMIT}`)
      .all() as unknown as FeedRow[];
  }
  if (kind === 'upcoming') {
    return db
      .prepare(
        `${FEED_BASE} AND r.dismissed = 0 AND r.release_date > ? ORDER BY r.release_date ASC LIMIT ${FEED_LIMIT}`,
      )
      .all(now) as unknown as FeedRow[];
  }
  return db
    .prepare(
      `${FEED_BASE} AND r.dismissed = 0 AND r.release_date <= ? AND r.release_date >= ?
       ORDER BY r.release_date DESC LIMIT ${FEED_LIMIT}`,
    )
    .all(now, since) as unknown as FeedRow[];
}

/* ------------------------------------------------------------------- scans */

export function startScanRecord(): number {
  const info = db
    .prepare("INSERT INTO scans (started_at, status) VALUES (?, 'running')")
    .run(nowIso());
  return Number(info.lastInsertRowid);
}

export function finishScanRecord(
  id: number,
  status: 'complete' | 'failed' | 'stopped',
  artistsSeen: number,
  newReleases: number,
  message: string | null,
): void {
  db.prepare(
    `UPDATE scans SET finished_at = ?, status = ?, artists_seen = ?, new_releases = ?, message = ?
     WHERE id = ?`,
  ).run(nowIso(), status, artistsSeen, newReleases, message, id);
}

export function recentScans(limit = 8): unknown[] {
  return db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?').all(limit);
}

export interface Counts {
  out: number;
  upcoming: number;
  artists: number;
  unresolved: number;
}

export function counts(recentDays: number): Counts {
  const now = today();
  const since = daysAgo(recentDays);
  const q = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  return {
    // The badge answers "how much is there for me to get", so anything already
    // on the server is left out of it even though the list still shows it.
    out: q(
      `SELECT COUNT(*) AS n FROM releases r JOIN artists a ON a.plex_key = r.plex_key
       WHERE a.muted = 0 AND a.present = 1 AND r.dismissed = 0 AND r.owned = 0
         AND r.release_date <= ? AND r.release_date >= ?`,
      now,
      since,
    ),
    upcoming: q(
      `SELECT COUNT(*) AS n FROM releases r JOIN artists a ON a.plex_key = r.plex_key
       WHERE a.muted = 0 AND a.present = 1 AND r.dismissed = 0
         AND r.release_date > ?`,
      now,
    ),
    artists: q('SELECT COUNT(*) AS n FROM artists WHERE present = 1 AND muted = 0'),
    unresolved: q(
      `SELECT COUNT(*) AS n FROM artists
       WHERE present = 1 AND muted = 0 AND mb_status IN ('ambiguous', 'not_found', 'error')`,
    ),
  };
}

/**
 * Recomputes which release groups are already held, from the current Plex album
 * list. Cheap, and needs no MusicBrainz call, so it can run whenever the
 * library changes rather than only during a full scan.
 */
export function refreshOwnedFlags(): number {
  db.exec(`UPDATE releases SET owned = 1
           WHERE EXISTS (SELECT 1 FROM plex_albums pa
                         WHERE pa.artist_key = releases.plex_key
                           AND pa.norm_title = releases.norm_title)`);
  db.exec(`UPDATE releases SET owned = 0
           WHERE NOT EXISTS (SELECT 1 FROM plex_albums pa
                             WHERE pa.artist_key = releases.plex_key
                               AND pa.norm_title = releases.norm_title)`);
  return ownedCount();
}

/** Releases already held, as last read from Plex. */
export function ownedCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM releases WHERE owned = 1').get() as { n: number }).n;
}

/** Episodes on the home server, as last read from Plex. */
export function localEpisodeCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM local_episodes').get() as { n: number }).n;
}
