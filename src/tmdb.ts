/**
 * Cinema and digital release dates for films.
 *
 * Plex returns a single date per film, which is its primary release, normally
 * the cinema date. It says nothing about when a film can actually be watched at
 * home. TMDB splits the two, and Plex hands us a TMDB id for every watchlist
 * film, so this is a direct lookup with no title matching involved.
 *
 * TMDB needs a free API key. Without one the app carries on using the single
 * Plex date and simply cannot tell cinema from digital.
 */
import { db } from './db.ts';
import * as store from './db.ts';
import { nowIso } from './dates.ts';
import type { ChartRow } from './trending.ts';

const API = 'https://api.themoviedb.org/3';
const DISCOVER = 'https://discover.provider.plex.tv';

/** Australia first, then the US, then whatever exists. */
const REGIONS = ['AU', 'US', 'GB'];

// TMDB release types.
const PREMIERE = 1;
const LIMITED = 2;
const THEATRICAL = 3;
const DIGITAL = 4;
const PHYSICAL = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS film_dates (
  rating_key   TEXT PRIMARY KEY,
  tmdb_id      TEXT,
  cinema_date  TEXT,
  digital_date TEXT,
  region       TEXT,
  checked_at   TEXT NOT NULL
);`;
db.exec(SCHEMA);

export interface FilmDates {
  cinema_date: string | null;
  digital_date: string | null;
  region: string | null;
}

interface TmdbRelease {
  release_date?: string;
  type?: number;
}
interface TmdbResult {
  results?: { iso_3166_1?: string; release_dates?: TmdbRelease[] }[];
}

function toDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** Earliest date of any of the wanted types, within one region. */
function earliest(releases: TmdbRelease[], types: number[]): string | null {
  const dates = releases
    .filter((r) => typeof r.type === 'number' && types.includes(r.type))
    .map((r) => toDate(r.release_date))
    .filter((d): d is string => d !== null)
    .sort();
  return dates[0] ?? null;
}

async function lookup(tmdbId: string, key: string): Promise<FilmDates | null> {
  const res = await fetch(`${API}/movie/${tmdbId}/release_dates?api_key=${key}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error('TMDB rejected the API key.');
  if (!res.ok) return null;

  const data = (await res.json()) as TmdbResult;
  const byRegion = new Map(
    (data.results ?? []).map((r) => [r.iso_3166_1 ?? '', r.release_dates ?? []]),
  );

  // A region is only used if it actually carries a digital date, otherwise the
  // search falls through. Australia rarely lists one; the US usually does.
  for (const region of [...REGIONS, ...byRegion.keys()]) {
    const releases = byRegion.get(region);
    if (!releases || releases.length === 0) continue;
    const digital = earliest(releases, [DIGITAL, PHYSICAL]);
    const cinema = earliest(releases, [THEATRICAL, LIMITED, PREMIERE]);
    if (digital || cinema) return { cinema_date: cinema, digital_date: digital, region };
  }
  return null;
}

/** Pulls the TMDB id Plex already holds for a film. */
async function tmdbIdFor(ratingKey: string, plexToken: string): Promise<string | null> {
  const res = await fetch(`${DISCOVER}/library/metadata/${ratingKey}`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': plexToken,
      'X-Plex-Product': 'Plex Media Tracker',
      'X-Plex-Client-Identifier': 'plex-media-tracker',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    MediaContainer?: { Metadata?: { Guid?: { id?: string }[] }[] };
  };
  for (const g of data.MediaContainer?.Metadata?.[0]?.Guid ?? []) {
    const m = g.id?.match(/^tmdb:\/\/(\d+)$/);
    if (m) return m[1]!;
  }
  return null;
}

export interface FilmDateSync {
  checked: number;
  withDigital: number;
  failed: number;
  skipped: boolean;
  message: string;
}

/** Re-check a film at most weekly: a pending digital date can appear any time. */
const STALE_DAYS = 7;

export async function syncFilmDates(
  onProgress?: (m: string) => void,
): Promise<FilmDateSync> {
  const key = store.getSetting('tmdb_api_key').trim();
  const plexToken = store.getSetting('plex_token');
  const result: FilmDateSync = {
    checked: 0,
    withDigital: 0,
    failed: 0,
    skipped: false,
    message: '',
  };

  if (!key) {
    result.skipped = true;
    result.message = 'No TMDB key set, so cinema and digital dates are not separated.';
    return result;
  }

  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const films = db
    .prepare(
      `SELECT w.rating_key, w.title FROM watchlist_items w
       LEFT JOIN film_dates f ON f.rating_key = w.rating_key
       WHERE w.type = 'movie' AND w.state = 'listed'
         AND (f.checked_at IS NULL OR f.checked_at < ? OR f.digital_date IS NULL)`,
    )
    .all(cutoff) as { rating_key: string; title: string }[];

  for (let i = 0; i < films.length; i += 1) {
    const film = films[i]!;
    onProgress?.(`Film dates, ${i + 1} of ${films.length}: ${film.title}`);
    try {
      const existing = db.prepare('SELECT tmdb_id FROM film_dates WHERE rating_key = ?').get(
        film.rating_key,
      ) as { tmdb_id: string | null } | undefined;

      const tmdbId = existing?.tmdb_id ?? (await tmdbIdFor(film.rating_key, plexToken));
      if (!tmdbId) {
        result.failed += 1;
        continue;
      }
      const dates = await lookup(tmdbId, key);
      db.prepare(
        `INSERT INTO film_dates (rating_key, tmdb_id, cinema_date, digital_date, region, checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(rating_key) DO UPDATE SET
           tmdb_id = excluded.tmdb_id, cinema_date = excluded.cinema_date,
           digital_date = excluded.digital_date, region = excluded.region,
           checked_at = excluded.checked_at`,
      ).run(
        film.rating_key,
        tmdbId,
        dates?.cinema_date ?? null,
        dates?.digital_date ?? null,
        dates?.region ?? null,
        nowIso(),
      );
      result.checked += 1;
      if (dates?.digital_date) result.withDigital += 1;
    } catch (err) {
      result.failed += 1;
      if ((err as Error).message.includes('rejected the API key')) {
        result.message = 'TMDB rejected the API key. Check it in Settings.';
        break;
      }
    }
  }

  if (!result.message) {
    result.message = `${result.checked} films dated, ${result.withDigital} with a digital date.`;
  }
  return result;
}

export interface FilmDateRow {
  rating_key: string;
  cinema_date: string | null;
  digital_date: string | null;
}

export function allFilmDates(): Map<string, FilmDateRow> {
  const rows = db
    .prepare('SELECT rating_key, cinema_date, digital_date FROM film_dates')
    .all() as unknown as FilmDateRow[];
  return new Map(rows.map((r) => [r.rating_key, r]));
}

export function hasAnyFilmDates(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM film_dates WHERE digital_date IS NOT NULL').get() as {
    n: number;
  };
  return row.n > 0;
}

/* ------------------------------------------------------------ trending */

/**
 * The chart runs 50 deep and TMDB pages 20 at a time, so three pages give 60
 * raw candidates to draw from. TMDB's trending list shifts between page
 * requests, so the same film can land on page one and then again on page
 * two; a chart week that repeats itself heavily can legitimately still be
 * short of 50 rows after dropping those repeats, which is not a bug.
 */
const CHART_DEPTH = 50;
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342';

interface TmdbTrendingItem {
  id?: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
}

export async function trendingFromTmdb(
  kind: 'movie' | 'show',
  key: string,
): Promise<ChartRow[]> {
  const path = kind === 'show' ? 'tv' : 'movie';
  const rows: ChartRow[] = [];
  // Guards against the list-shifting duplicates described above. Checked
  // before the depth check so a run of repeats near the end of a page
  // cannot eat into the 50 slots meant for distinct films.
  const seen = new Set<number>();

  for (let page = 1; page <= 3 && rows.length < CHART_DEPTH; page += 1) {
    const res = await fetch(`${API}/trending/${path}/week?api_key=${key}&page=${page}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error('TMDB rejected the API key.');
    // A short chart must mean genuinely few distinct trending items, never a
    // failed page that happens to look like one. The caller reports this
    // chart as failed rather than silently showing a truncated one.
    if (!res.ok) throw new Error(`TMDB returned HTTP ${res.status}`);

    const data = (await res.json()) as { results?: TmdbTrendingItem[] };
    for (const r of data.results ?? []) {
      const title = r.title ?? r.name;
      if (!r.id || !title) continue;
      if (seen.has(r.id)) continue;
      if (rows.length >= CHART_DEPTH) break;
      seen.add(r.id);
      rows.push({
        kind,
        id: String(r.id),
        rank: rows.length + 1,
        title,
        subtitle: '',
        release_date: (r.release_date ?? r.first_air_date ?? '').slice(0, 10) || null,
        thumb: r.poster_path ? `${TMDB_IMAGE}${r.poster_path}` : null,
        link: `https://www.themoviedb.org/${path}/${r.id}`,
      });
    }
  }
  return rows;
}
