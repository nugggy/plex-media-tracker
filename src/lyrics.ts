/**
 * Lyrics for tracks in the Plex music library, fetched from LRCLIB and kept
 * in this app's own database. Nothing is written to the music library. The
 * only module that knows the LRCLIB shapes, the matching rules and the tables.
 * See docs/specs/2026-09-20-lyrics-design.md.
 */
import { db } from './db.ts';
import { USER_AGENT } from './config.ts';
import { normaliseArtistName } from './matching.ts';
import { nowIso } from './dates.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lyrics (
  rating_key   TEXT PRIMARY KEY,
  artist       TEXT NOT NULL,
  title        TEXT NOT NULL,
  album        TEXT,
  duration_ms  INTEGER,
  source       TEXT NOT NULL,
  synced       TEXT,
  plain        TEXT,
  instrumental INTEGER NOT NULL DEFAULT 0,
  fetched_at   TEXT NOT NULL
);
-- "We looked and LRCLIB has nothing" kept apart from "nobody has asked", so a
-- dead end is remembered for a fortnight rather than re-asked on every press.
CREATE TABLE IF NOT EXISTS lyrics_misses (
  rating_key TEXT PRIMARY KEY,
  tried_at   TEXT NOT NULL
);`;
db.exec(SCHEMA);

const LRCLIB = 'https://lrclib.net/api';
/** LRCLIB matches on duration; this is how far out a search candidate may be. */
export const DURATION_TOLERANCE_S = 3;
export const MISS_RECHECK_DAYS = 14;
/** Lookups are spaced out to stay a polite client. LRCLIB publishes no hard limit. */
const GAP_MS = 200;

export interface Track {
  rating_key: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  /** True when Plex itself already carries a lyrics stream for the track. */
  covered: boolean;
}

export type TrackState = 'covered' | 'stored' | 'instrumental' | 'missing';

export interface StoredLyric {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

export type LyricSource = 'lrclib' | 'manual';

export interface LyricRow extends StoredLyric {
  rating_key: string;
  artist: string;
  title: string;
  album: string | null;
  duration_ms: number | null;
  source: LyricSource;
  fetched_at: string;
}

/** The fields of an LRCLIB record this app reads. Both endpoints return the same shape. */
export interface LrcRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/* ------------------------------------------------------------- matching */

/** Synced when there is one, plain otherwise; an instrumental is its own answer. */
export function fromLrclib(r: LrcRecord): StoredLyric | null {
  if (r.instrumental === true) return { synced: null, plain: null, instrumental: true };
  const synced = (r.syncedLyrics ?? '').trim() || null;
  const plain = (r.plainLyrics ?? '').trim() || null;
  if (!synced && !plain) return null;
  return { synced, plain, instrumental: false };
}

function durationGap(track: Track, c: LrcRecord): number | null {
  if (track.duration_ms === null || typeof c.duration !== 'number') return null;
  return Math.abs(track.duration_ms / 1000 - c.duration);
}

/**
 * The best search candidate, or none. The artist must match, and the duration
 * must be within tolerance, because a candidate ten seconds out is a different
 * recording and no lyric beats the wrong lyric. A track whose duration Plex
 * does not know can only be matched on the artist.
 */
export function pickCandidate(track: Track, candidates: LrcRecord[]): LrcRecord | null {
  const artist = normaliseArtistName(track.artist);
  let best: { c: LrcRecord; gap: number } | null = null;
  for (const c of candidates) {
    if (normaliseArtistName(c.artistName ?? '') !== artist) continue;
    if (!fromLrclib(c)) continue;
    const gap = durationGap(track, c);
    if (gap === null) return c;
    if (gap > DURATION_TOLERANCE_S) continue;
    if (!best || gap < best.gap) best = { c, gap };
  }
  return best?.c ?? null;
}

export function missStillFresh(triedAt: string | undefined, now: number = Date.now()): boolean {
  if (!triedAt) return false;
  const age = now - Date.parse(triedAt);
  return !Number.isNaN(age) && age >= 0 && age < MISS_RECHECK_DAYS * 86_400_000;
}

/* -------------------------------------------------------------- storage */

export function saveLyric(track: Track, lyric: StoredLyric, source: LyricSource): void {
  db.prepare(
    `INSERT INTO lyrics (rating_key, artist, title, album, duration_ms, source, synced, plain,
                         instrumental, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rating_key) DO UPDATE SET
       artist = excluded.artist, title = excluded.title, album = excluded.album,
       duration_ms = excluded.duration_ms, source = excluded.source, synced = excluded.synced,
       plain = excluded.plain, instrumental = excluded.instrumental, fetched_at = excluded.fetched_at`,
  ).run(
    track.rating_key,
    track.artist,
    track.title,
    track.album,
    track.duration_ms,
    source,
    lyric.synced,
    lyric.plain,
    lyric.instrumental ? 1 : 0,
    nowIso(),
  );
  db.prepare('DELETE FROM lyrics_misses WHERE rating_key = ?').run(track.rating_key);
}

export function getLyric(ratingKey: string): LyricRow | undefined {
  const row = db.prepare('SELECT * FROM lyrics WHERE rating_key = ?').get(ratingKey) as
    | (Omit<LyricRow, 'instrumental'> & { instrumental: number })
    | undefined;
  return row ? { ...row, instrumental: row.instrumental === 1 } : undefined;
}

export function recordMiss(ratingKey: string, at: string = nowIso()): void {
  db.prepare(
    `INSERT INTO lyrics_misses (rating_key, tried_at) VALUES (?, ?)
     ON CONFLICT(rating_key) DO UPDATE SET tried_at = excluded.tried_at`,
  ).run(ratingKey, at);
}

export function lastMiss(ratingKey: string): string | undefined {
  const row = db.prepare('SELECT tried_at FROM lyrics_misses WHERE rating_key = ?').get(ratingKey) as
    | { tried_at: string }
    | undefined;
  return row?.tried_at;
}

/** Each track with what this app knows about it. Covered wins: Plex already has it. */
export function trackStates(
  tracks: Track[],
): (Track & { state: TrackState; source: LyricSource | null })[] {
  return tracks.map((t) => {
    if (t.covered) return { ...t, state: 'covered', source: null };
    const held = getLyric(t.rating_key);
    if (!held) return { ...t, state: 'missing', source: null };
    return { ...t, state: held.instrumental ? 'instrumental' : 'stored', source: held.source };
  });
}

/* --------------------------------------------------------------- LRCLIB */

async function lrclib(path: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(`${LRCLIB}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
}

/** The exact lookup first, then a search judged by artist and duration. */
export async function lookupLyric(track: Track): Promise<StoredLyric | null> {
  const exact: Record<string, string> = { artist_name: track.artist, track_name: track.title };
  if (track.album) exact.album_name = track.album;
  if (track.duration_ms !== null) exact.duration = String(Math.round(track.duration_ms / 1000));
  const got = await lrclib('/get', exact);
  if (got.ok) {
    const lyric = fromLrclib((await got.json()) as LrcRecord);
    if (lyric) return lyric;
  } else if (got.status !== 404) {
    throw new Error(`LRCLIB returned HTTP ${got.status}`);
  }

  const found = await lrclib('/search', { artist_name: track.artist, track_name: track.title });
  if (!found.ok) throw new Error(`LRCLIB returned HTTP ${found.status}`);
  const candidates = (await found.json()) as LrcRecord[];
  const pick = pickCandidate(track, Array.isArray(candidates) ? candidates : []);
  return pick ? fromLrclib(pick) : null;
}

export interface FetchResult {
  found: number;
  instrumental: number;
  missed: number;
  skipped: number;
  failed: number;
  message: string;
}

const progress = { running: false, message: '' };
export const lyricsProgress = (): { running: boolean; message: string } => ({ ...progress });

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetches for every track handed in that is not covered, stored or a fresh
 * miss. One deliberate press does one run; nothing here is automatic.
 */
export async function fetchLyrics(tracks: Track[]): Promise<FetchResult> {
  if (progress.running) throw new Error('Lyrics are already being fetched.');
  progress.running = true;
  const result: FetchResult = { found: 0, instrumental: 0, missed: 0, skipped: 0, failed: 0, message: '' };
  try {
    const todo = trackStates(tracks).filter((t) => t.state === 'missing');
    for (let i = 0; i < todo.length; i += 1) {
      const track = todo[i]!;
      progress.message = `Lyrics, ${i + 1} of ${todo.length}: ${track.title}`;
      if (missStillFresh(lastMiss(track.rating_key))) {
        result.skipped += 1;
        continue;
      }
      try {
        const lyric = await lookupLyric(track);
        if (lyric) {
          saveLyric(track, lyric, 'lrclib');
          if (lyric.instrumental) result.instrumental += 1;
          else result.found += 1;
        } else {
          recordMiss(track.rating_key);
          result.missed += 1;
        }
      } catch {
        result.failed += 1;
      }
      await sleep(GAP_MS);
    }
    result.message =
      `${result.found} lyrics found, ${result.instrumental} instrumental, ${result.missed} not on LRCLIB` +
      (result.skipped ? `, ${result.skipped} skipped as asked recently` : '') +
      (result.failed ? `, ${result.failed} failed` : '') +
      '.';
    progress.message = result.message;
    return result;
  } finally {
    progress.running = false;
  }
}
