/**
 * Synopsis, cast and the rest of the detail behind a search result.
 *
 * Plex Discover answers with everything except, sometimes, a cast list. It
 * costs no API key and it carries the TMDB id in the same response, so when a
 * TMDB key is set and Plex gave no roles, TMDB fills the actors in. Without a
 * key you still get the synopsis, runtime, rating and genres.
 *
 * Answers are cached for a fortnight. A film's synopsis does not change, and
 * the lookup is two network calls that would otherwise repeat on every press.
 */
import { db } from './db.ts';
import * as store from './db.ts';
import { nowIso } from './dates.ts';
import { APP_NAME } from './config.ts';

const DISCOVER = 'https://discover.provider.plex.tv';
const TMDB = 'https://api.themoviedb.org/3';

/** Enough to recognise a film by, short enough to read without scrolling. */
export const MAX_CAST = 8;

/** Matching the YouTube cache, for the same reason: answers barely move. */
const CACHE_DAYS = 14;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS detail_cache (
  rating_key TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  looked_up  TEXT NOT NULL
);`;
db.exec(SCHEMA);

export interface CastMember {
  name: string;
  role: string;
}

export interface Details {
  summary: string;
  tagline: string;
  runtime_minutes: number | null;
  content_rating: string;
  rating: number | null;
  genres: string[];
  directors: string[];
  cast: CastMember[];
  studio: string;
  tmdb_id: string | null;
}

/* ------------------------------------------------------------- parsing */

interface Tagged {
  tag?: string;
  role?: string;
}

const tags = (list: unknown): string[] =>
  Array.isArray(list)
    ? (list as Tagged[]).map((t) => t.tag ?? '').filter((t) => t !== '')
    : [];

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Pulls the one film or show out of a Discover metadata response. */
export function parsePlexDetails(raw: unknown): Details | null {
  const meta = (raw as { MediaContainer?: { Metadata?: Record<string, unknown>[] } })
    ?.MediaContainer?.Metadata?.[0];
  if (!meta) return null;

  const duration = typeof meta.duration === 'number' ? meta.duration : null;
  const rating = typeof meta.audienceRating === 'number' ? meta.audienceRating : null;

  let tmdbId: string | null = null;
  for (const g of (meta.Guid as { id?: string }[] | undefined) ?? []) {
    const m = g.id?.match(/^tmdb:\/\/(\d+)$/);
    if (m) tmdbId = m[1]!;
  }

  const roles = Array.isArray(meta.Role) ? (meta.Role as Tagged[]) : [];

  return {
    summary: text(meta.summary),
    tagline: text(meta.tagline),
    // Plex counts in milliseconds. Whole minutes is what anyone reads.
    runtime_minutes: duration ? Math.round(duration / 60_000) : null,
    content_rating: text(meta.contentRating),
    rating,
    genres: tags(meta.Genre),
    directors: tags(meta.Director),
    cast: roles
      .filter((r) => r.tag)
      .slice(0, MAX_CAST)
      .map((r) => ({ name: r.tag!, role: r.role ?? '' })),
    studio: text(meta.studio),
    tmdb_id: tmdbId,
  };
}

interface TmdbCredits {
  credits?: {
    cast?: { name?: string; character?: string }[];
    crew?: { name?: string; job?: string }[];
  };
}

/**
 * Fills in what Plex left out. Anything Plex did supply is left alone, because
 * it is the source that matches the rest of the app.
 */
export function applyTmdbCredits(details: Details, raw: unknown): Details {
  const credits = (raw as TmdbCredits)?.credits;
  if (!credits) return details;

  const out = { ...details };

  if (out.cast.length === 0) {
    out.cast = (credits.cast ?? [])
      .filter((c) => c.name)
      .slice(0, MAX_CAST)
      .map((c) => ({ name: c.name!, role: c.character ?? '' }));
  }
  if (out.directors.length === 0) {
    out.directors = (credits.crew ?? [])
      .filter((c) => c.job === 'Director' && c.name)
      .map((c) => c.name!);
  }
  return out;
}

/* ------------------------------------------------------------- fetching */

async function plexMetadata(ratingKey: string, token: string): Promise<unknown> {
  const res = await fetch(`${DISCOVER}/library/metadata/${ratingKey}`, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Product': APP_NAME,
      'X-Plex-Client-Identifier': 'plex-media-tracker',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`plex.tv returned HTTP ${res.status}`);
  return res.json();
}

async function tmdbCredits(kind: string, tmdbId: string, key: string): Promise<unknown> {
  const path = kind === 'show' ? 'tv' : 'movie';
  const res = await fetch(
    `${TMDB}/${path}/${tmdbId}?api_key=${key}&append_to_response=credits`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) return null;
  return res.json();
}

export interface DetailsResponse extends Details {
  /** Set when the cast is missing and a TMDB key would have supplied it. */
  note: string | null;
}

const isFresh = (lookedUp: string): boolean =>
  Date.now() - Date.parse(lookedUp) < CACHE_DAYS * 86_400_000;

function cached(ratingKey: string): Details | null {
  const row = db
    .prepare('SELECT payload, looked_up FROM detail_cache WHERE rating_key = ?')
    .get(ratingKey) as { payload: string; looked_up: string } | undefined;
  if (!row || !isFresh(row.looked_up)) return null;
  try {
    return JSON.parse(row.payload) as Details;
  } catch {
    return null;
  }
}

function remember(ratingKey: string, details: Details): void {
  db.prepare(
    `INSERT INTO detail_cache (rating_key, payload, looked_up) VALUES (?, ?, ?)
     ON CONFLICT(rating_key) DO UPDATE SET
       payload = excluded.payload, looked_up = excluded.looked_up`,
  ).run(ratingKey, JSON.stringify(details), nowIso());
}

export async function getDetails(kind: string, ratingKey: string): Promise<DetailsResponse> {
  const token = store.getSetting('plex_token');
  if (!token) throw new Error('No Plex token stored.');

  const key = store.getSetting('tmdb_api_key').trim();
  const hit = cached(ratingKey);
  if (hit) return { ...hit, note: noteFor(hit, key) };

  const parsed = parsePlexDetails(await plexMetadata(ratingKey, token));
  if (!parsed) throw new Error('Plex returned nothing for that title.');

  let details = parsed;
  if (details.cast.length === 0 && details.tmdb_id && key) {
    try {
      details = applyTmdbCredits(details, await tmdbCredits(kind, details.tmdb_id, key));
    } catch {
      // The synopsis is worth showing even when the cast lookup fails.
    }
  }

  remember(ratingKey, details);
  return { ...details, note: noteFor(details, key) };
}

function noteFor(details: Details, tmdbKey: string): string | null {
  if (details.cast.length > 0) return null;
  if (!tmdbKey) return 'Plex listed no cast. A free TMDB key in Settings would add the actors.';
  return 'No cast listed for this title.';
}
