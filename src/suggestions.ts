/**
 * Suggestions built from what is already in the library, with no API key.
 *
 * Music comes from ListenBrainz similar-artists, which is free and open and
 * needs no key. Films come from TMDB recommendations, which needs the same key
 * as film dates, so without one there are no film suggestions at all. The
 * reason Plex's own similar-item endpoint is not used is explained above
 * buildVideoSuggestions.
 *
 * Shows work the same way through TMDB's television recommendations, with one
 * extra step: nothing stores a TMDB id for a show, so each seed show has its id
 * read off Plex once and cached.
 *
 * Both sources work the same way: take a sample of things the user already has,
 * ask what resembles each of them, add up the scores, then subtract everything
 * they already own or have watchlisted. What is left is ranked by how often it
 * came up, so an artist suggested by six of your artists outranks one suggested
 * by one. Films are then reordered to put this year's releases first, because
 * the tab shows this year onwards by default.
 */
import { db } from './db.ts';
import * as store from './db.ts';
import { nowIso, today } from './dates.ts';
import { normaliseArtistName } from './matching.ts';
import { getArtistInfo } from './artistinfo.ts';

/** TMDB serves posters off its own image host, which the thumb proxy allows. */
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342';

const LB_SIMILAR =
  'https://labs.api.listenbrainz.org/similar-artists/json?algorithm=' +
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

/** How many of the user's own items to use as seeds. Enough to be representative. */
const MUSIC_SEEDS = 40;
const VIDEO_SEEDS = 40;
const LB_GAP_MS = 1100;

/**
 * How often the artist detail pass writes what it has found so far. Ten is
 * roughly twenty seconds of lookups, so the tab fills in visibly without the
 * build spending its time rewriting the table.
 */
const DETAIL_FLUSH_EVERY = 10;

export interface Suggestion {
  kind: 'artist' | 'movie' | 'show';
  id: string;
  title: string;
  subtitle: string;
  score: number;
  seeds: string[];
  link: string | null;
  year: number | null;
  /** Poster or photograph, ready for the /thumb proxy. Null when none was found. */
  thumb: string | null;
  /** A synopsis for a film or show, a line of description for an artist. */
  overview: string;
  /**
   * What the watchlist API needs. For a film or show the suggestion's id is a
   * plex:// guid whose tail is exactly that key; an artist has none.
   */
  rating_key: string | null;
  /** Already on the watchlist, or already a watched artist. */
  tracked: boolean;
}

export interface SuggestionRun {
  music: number;
  video: number;
  generated_at: string;
  message: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suggestions (
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  title     TEXT NOT NULL,
  subtitle  TEXT NOT NULL DEFAULT '',
  year      INTEGER,
  score     REAL NOT NULL DEFAULT 0,
  seeds     TEXT NOT NULL DEFAULT '[]',
  link      TEXT,
  thumb     TEXT,
  overview  TEXT NOT NULL DEFAULT '',
  hidden    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, id)
);`;
db.exec(SCHEMA);

// Lightweight migration: databases made before the cards had pictures.
for (const sql of [
  'ALTER TABLE suggestions ADD COLUMN thumb TEXT',
  "ALTER TABLE suggestions ADD COLUMN overview TEXT NOT NULL DEFAULT ''",
]) {
  try {
    db.exec(sql);
  } catch {
    // Column already present.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ music */

interface LbArtist {
  artist_mbid: string;
  name: string;
  comment?: string;
  score?: number;
  reference_mbid?: string;
}

async function similarArtists(mbid: string): Promise<LbArtist[]> {
  try {
    const res = await fetch(`${LB_SIMILAR}&artist_mbids=${mbid}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as LbArtist[]) : [];
  } catch {
    return [];
  }
}

async function buildMusicSuggestions(
  onProgress?: (m: string) => void,
): Promise<Suggestion[]> {
  const owned = store.allArtists().filter((a) => a.muted === 0 && a.mbid);
  const ownedMbids = new Set(owned.map((a) => a.mbid!));
  const ownedNames = new Set(owned.map((a) => normaliseArtistName(a.name)));

  const seeds = [...owned]
    .sort((a, b) => b.album_count - a.album_count)
    .slice(0, MUSIC_SEEDS);

  const tally = new Map<string, Suggestion>();

  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i]!;
    onProgress?.(`Music suggestions, ${i + 1} of ${seeds.length}: ${seed.name}`);
    const similar = await similarArtists(seed.mbid!);

    for (const candidate of similar.slice(0, 25)) {
      if (!candidate.artist_mbid || !candidate.name) continue;
      if (ownedMbids.has(candidate.artist_mbid)) continue;
      if (ownedNames.has(normaliseArtistName(candidate.name))) continue;

      const existing = tally.get(candidate.artist_mbid);
      if (existing) {
        existing.score += candidate.score ?? 1;
        if (existing.seeds.length < 5) existing.seeds.push(seed.name);
      } else {
        tally.set(candidate.artist_mbid, {
          kind: 'artist',
          id: candidate.artist_mbid,
          title: candidate.name,
          subtitle: candidate.comment ?? '',
          year: null,
          score: candidate.score ?? 1,
          seeds: [seed.name],
          link: `https://musicbrainz.org/artist/${candidate.artist_mbid}`,
          thumb: null,
          overview: '',
          rating_key: null,
          tracked: false,
        });
      }
    }
    await sleep(LB_GAP_MS);
  }

  // Something suggested by several of your artists is a better bet than one
  // strong match, so the seed count weighs on the score.
  for (const s of tally.values()) s.score = s.score * Math.sqrt(s.seeds.length);

  const ranked = [...tally.values()].sort((a, b) => b.score - a.score).slice(0, 100);

  // Written out before the detail pass, and again as it goes, because that
  // pass takes minutes and used to be all or nothing: a restart part way
  // through threw away the whole ListenBrainz run and left the tab showing
  // whatever the previous build had saved, pictureless.
  save(ranked, ['artist']);
  await addArtistDetail(ranked, onProgress, () => save(ranked, ['artist']));
  return ranked;
}

/**
 * Fills in each artist's picture and description, in place.
 *
 * This is the slowest part of a music build, because MusicBrainz allows one
 * request a second and there is one per artist. It is worth it: without it an
 * artist card is a letter in a grey box and a name, which says nothing about
 * whether the suggestion is any good. The cache behind getArtistInfo means
 * only artists new to the list cost anything, so a second build is quick.
 *
 * A failure for one artist leaves that card plain rather than ending the run.
 */
async function addArtistDetail(
  rows: Suggestion[],
  onProgress?: (m: string) => void,
  flush?: () => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    onProgress?.(`Artist details, ${i + 1} of ${rows.length}: ${row.title}`);
    const info = await getArtistInfo(row.id);
    row.thumb = info.thumb;
    row.overview = info.blurb;
    if (flush && (i + 1) % DETAIL_FLUSH_EVERY === 0) flush();
  }
  flush?.();
}

/* ------------------------------------------------------------- films and TV */

interface PlexItem {
  ratingKey?: string;
  guid?: string;
  title?: string;
  year?: number;
  type?: string;
}

async function plexJson(base: string, token: string, path: string): Promise<unknown> {
  const url = `${base.replace(/\/+$/, '')}${path}${path.includes('?') ? '&' : '?'}X-Plex-Token=${token}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`Plex returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Plex's own similar-item endpoint only ever returns titles already in the
 * library, so it cannot suggest anything new. TMDB recommendations can, and the
 * watchlist already carries a TMDB id for every film it has dated, so those
 * become the seeds at no extra lookup cost.
 */
async function buildVideoSuggestions(
  onProgress?: (m: string) => void,
): Promise<Suggestion[]> {
  const key = store.getSetting('tmdb_api_key').trim();
  if (!key) return [];

  // Everything already held or already watchlisted is excluded from results.
  const have = new Set<string>(
    (db.prepare('SELECT guid FROM library_guids').all() as { guid: string }[]).map((r) => r.guid),
  );
  for (const row of db.prepare('SELECT guid FROM watchlist_items').all() as { guid: string }[]) {
    have.add(row.guid);
  }

  const seeds = db
    .prepare(
      `SELECT f.tmdb_id, w.title FROM film_dates f
       JOIN watchlist_items w ON w.rating_key = f.rating_key
       WHERE f.tmdb_id IS NOT NULL AND w.state = 'listed'
       ORDER BY w.added_at DESC`,
    )
    .all() as { tmdb_id: string; title: string }[];

  const chosen = pickSpread(seeds, VIDEO_SEEDS);
  const tally = new Map<string, Suggestion>();

  for (let i = 0; i < chosen.length; i += 1) {
    const seed = chosen[i]!;
    onProgress?.(`Film suggestions, ${i + 1} of ${chosen.length}: ${seed.title}`);
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/movie/${seed.tmdb_id}/recommendations?api_key=${key}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: TmdbMovieResult[] };

      for (const raw of (data.results ?? []).slice(0, 10)) {
        const candidate = movieCandidate(raw, seed.title);
        if (!candidate) continue;
        const existing = tally.get(candidate.id);
        if (existing) {
          existing.score += 1;
          if (existing.seeds.length < 5) existing.seeds.push(seed.title);
        } else {
          tally.set(candidate.id, candidate);
        }
      }
    } catch {
      // One bad seed should not end the run.
    }
  }

  // A TMDB id is not what the watchlist wants, so each survivor is matched back
  // to Plex to get a key it can actually be added with.
  const ranked = rankRecentFirst([...tally.values()], Number(today().slice(0, 4))).slice(0, 60);
  const out: Suggestion[] = [];
  const token = store.getSetting('plex_token');

  for (let i = 0; i < ranked.length; i += 1) {
    const cand = ranked[i]!;
    onProgress?.(`Matching suggestion ${i + 1} of ${ranked.length}: ${cand.title}`);
    const match = await findOnPlex(cand.title, cand.year, token);
    if (!match || have.has(match.guid)) continue;
    cand.id = match.guid;
    cand.rating_key = match.ratingKey;
    out.push(cand);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * Recent titles first, each group still ordered by score.
 *
 * TMDB recommendations lean heavily on catalogue, so ranking by score alone
 * fills the list with films from decades ago, and the Suggestions tab, which
 * shows this year onwards by default, then comes up almost empty. Older titles
 * are kept rather than dropped, so turning the toggle on still has something to
 * show. A film with no year counts as recent, on the same reasoning as the feed
 * filter: hiding something new for want of a date is the worse error.
 */
export function rankRecentFirst(rows: Suggestion[], currentYear: number): Suggestion[] {
  const recent = (r: Suggestion): boolean => r.year === null || r.year >= currentYear;
  return [...rows].sort((a, b) => {
    if (recent(a) !== recent(b)) return recent(a) ? -1 : 1;
    return b.score - a.score;
  });
}

/**
 * TMDB gives the poster as a path, and the size goes in the URL. w342 is the
 * smallest size that still looks right on the 76px card tile at twice the
 * pixel density; the original files are several megabytes and would make the
 * tab crawl. The leading slash is tolerated either way, because a path
 * missing one would otherwise resolve a directory up and quietly 404.
 */
export function tmdbPoster(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface TmdbMovieResult {
  id?: number;
  title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
}

/**
 * One TMDB film recommendation as a suggestion.
 *
 * The id is namespaced by kind, because TMDB numbers films and shows in
 * separate sequences and 550 means a different thing in each.
 */
export function movieCandidate(raw: TmdbMovieResult, seed: string): Suggestion | null {
  if (!raw.id || !raw.title) return null;
  return {
    kind: 'movie',
    id: `tmdb://movie/${raw.id}`,
    title: raw.title,
    subtitle: '',
    year: raw.release_date ? Number(raw.release_date.slice(0, 4)) || null : null,
    score: 1,
    seeds: [seed],
    link: `https://www.themoviedb.org/movie/${raw.id}`,
    thumb: tmdbPoster(raw.poster_path),
    overview: raw.overview ?? '',
    rating_key: null,
    tracked: false,
  };
}

export interface TmdbTvResult {
  id?: number;
  name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
}

/**
 * TMDB names a show where it titles a film, and dates it from its first air
 * date rather than a release date. Getting that wrong yields a list of
 * untitled, undated suggestions, so it is worth its own function and its own
 * tests.
 */
export function tvCandidate(raw: TmdbTvResult, seed: string): Suggestion | null {
  if (!raw.id || !raw.name) return null;
  return {
    kind: 'show',
    id: `tmdb://show/${raw.id}`,
    title: raw.name,
    subtitle: '',
    year: raw.first_air_date ? Number(raw.first_air_date.slice(0, 4)) || null : null,
    score: 1,
    seeds: [seed],
    link: `https://www.themoviedb.org/tv/${raw.id}`,
    thumb: tmdbPoster(raw.poster_path),
    overview: raw.overview ?? '',
    rating_key: null,
    tracked: false,
  };
}

const SHOW_TMDB = `
CREATE TABLE IF NOT EXISTS show_tmdb_ids (
  rating_key TEXT PRIMARY KEY,
  tmdb_id    TEXT,
  looked_up  TEXT NOT NULL
);`;
db.exec(SHOW_TMDB);

/**
 * A show's TMDB id, read off Plex once and kept.
 *
 * The watchlist already carries a TMDB id for every film it has dated, but
 * nothing holds one for a show, so this is the extra step the show path needs.
 */
async function showTmdbId(ratingKey: string, token: string): Promise<string | null> {
  const row = db
    .prepare('SELECT tmdb_id FROM show_tmdb_ids WHERE rating_key = ?')
    .get(ratingKey) as { tmdb_id: string | null } | undefined;
  if (row) return row.tmdb_id;

  let id: string | null = null;
  try {
    const res = await fetch(`https://discover.provider.plex.tv/library/metadata/${ratingKey}`, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': token,
        'X-Plex-Product': 'Plex Media Tracker',
        'X-Plex-Client-Identifier': 'plex-media-tracker',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        MediaContainer?: { Metadata?: { Guid?: { id?: string }[] }[] };
      };
      for (const g of data.MediaContainer?.Metadata?.[0]?.Guid ?? []) {
        const m = g.id?.match(/^tmdb:\/\/(\d+)$/);
        if (m) id = m[1]!;
      }
    }
  } catch {
    // Cached as nothing, so a broken show is not retried on every build.
  }
  db.prepare(
    'INSERT OR REPLACE INTO show_tmdb_ids (rating_key, tmdb_id, looked_up) VALUES (?, ?, ?)',
  ).run(ratingKey, id, nowIso());
  return id;
}

/** Shows work like films, once each seed show has a TMDB id to ask about. */
async function buildShowSuggestions(
  onProgress?: (m: string) => void,
): Promise<Suggestion[]> {
  const key = store.getSetting('tmdb_api_key').trim();
  const token = store.getSetting('plex_token');
  if (!key || !token) return [];

  const have = new Set<string>(
    (db.prepare('SELECT guid FROM library_guids').all() as { guid: string }[]).map((r) => r.guid),
  );
  for (const row of db.prepare('SELECT guid FROM watchlist_items').all() as { guid: string }[]) {
    have.add(row.guid);
  }

  const shows = db
    .prepare(
      `SELECT rating_key, title FROM watchlist_items
       WHERE type = 'show' AND state = 'listed' ORDER BY added_at DESC`,
    )
    .all() as { rating_key: string; title: string }[];

  const chosen = pickSpread(shows, VIDEO_SEEDS);
  const tally = new Map<string, Suggestion>();

  for (let i = 0; i < chosen.length; i += 1) {
    const seed = chosen[i]!;
    onProgress?.(`Show suggestions, ${i + 1} of ${chosen.length}: ${seed.title}`);
    try {
      const tmdbId = await showTmdbId(seed.rating_key, token);
      if (!tmdbId) continue;

      const res = await fetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/recommendations?api_key=${key}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: TmdbTvResult[] };

      for (const raw of (data.results ?? []).slice(0, 10)) {
        const candidate = tvCandidate(raw, seed.title);
        if (!candidate) continue;
        const existing = tally.get(candidate.id);
        if (existing) {
          existing.score += 1;
          if (existing.seeds.length < 5) existing.seeds.push(seed.title);
        } else {
          tally.set(candidate.id, candidate);
        }
      }
    } catch {
      // One bad seed should not end the run.
    }
  }

  const ranked = rankRecentFirst([...tally.values()], Number(today().slice(0, 4))).slice(0, 60);
  const out: Suggestion[] = [];

  for (let i = 0; i < ranked.length; i += 1) {
    const cand = ranked[i]!;
    onProgress?.(`Matching show ${i + 1} of ${ranked.length}: ${cand.title}`);
    const match = await findOnPlex(cand.title, cand.year, token, 'show');
    if (!match || have.has(match.guid)) continue;
    cand.id = match.guid;
    cand.rating_key = match.ratingKey;
    out.push(cand);
    if (out.length >= 40) break;
  }
  return out;
}

/** Finds a film or show on Plex Discover so a suggestion can be added. */
async function findOnPlex(
  title: string,
  year: number | null,
  token: string,
  type: 'movie' | 'show' = 'movie',
): Promise<{ guid: string; ratingKey: string } | null> {
  if (!token) return null;
  try {
    const url =
      `https://discover.provider.plex.tv/library/search?query=${encodeURIComponent(title)}` +
      `&searchTypes=${type === 'show' ? 'tv' : 'movies'}` +
      `&searchProviders=discover&limit=5&includeMetadata=1`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': token,
        'X-Plex-Product': 'Plex Media Tracker',
        'X-Plex-Client-Identifier': 'plex-media-tracker',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      MediaContainer?: {
        SearchResults?: { SearchResult?: { Metadata?: PlexItem }[] }[];
      };
    };
    for (const group of data.MediaContainer?.SearchResults ?? []) {
      for (const entry of group.SearchResult ?? []) {
        const m = entry.Metadata;
        if (!m?.ratingKey || !m.title || m.type !== type) continue;
        const sameTitle = normaliseArtistName(m.title) === normaliseArtistName(title);
        const sameYear = !year || !m.year || Math.abs(m.year - year) <= 1;
        if (sameTitle && sameYear) {
          return { guid: m.guid ?? `plex://${type}/${m.ratingKey}`, ratingKey: String(m.ratingKey) };
        }
      }
    }
  } catch {
    // No match is fine; the suggestion is simply dropped.
  }
  return null;
}

/** Evenly spaced picks, so the sample is not all one corner of the alphabet. */
function pickSpread<T>(pool: T[], count: number): T[] {
  if (pool.length <= count) return pool;
  const step = pool.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) out.push(pool[Math.floor(i * step)]!);
  return out;
}

/* ------------------------------------------------------------------ store */

function save(rows: Suggestion[], kinds: string[]): void {
  db.exec('BEGIN');
  try {
    // Hidden entries survive a rebuild so a dismissal sticks.
    const hidden = new Set(
      (db.prepare('SELECT kind, id FROM suggestions WHERE hidden = 1').all() as {
        kind: string;
        id: string;
      }[]).map((r) => `${r.kind}:${r.id}`),
    );
    for (const kind of kinds) db.prepare('DELETE FROM suggestions WHERE kind = ?').run(kind);

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO suggestions
         (kind, id, title, subtitle, year, score, seeds, link, thumb, overview, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of rows) {
      stmt.run(
        s.kind,
        s.id,
        s.title,
        s.subtitle,
        s.year,
        s.score,
        JSON.stringify(s.seeds),
        s.link,
        s.thumb,
        s.overview,
        hidden.has(`${s.kind}:${s.id}`) ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listSuggestions(includeHidden = false): Suggestion[] {
  const rows = db
    .prepare(
      `SELECT * FROM suggestions ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY score DESC`,
    )
    .all() as {
    kind: string;
    id: string;
    title: string;
    subtitle: string;
    year: number | null;
    score: number;
    seeds: string;
    link: string | null;
    thumb: string | null;
    overview: string | null;
    hidden: number;
  }[];

  const watchlisted = new Set(
    (db.prepare("SELECT guid FROM watchlist_items WHERE state = 'listed'").all() as {
      guid: string;
    }[]).map((r) => r.guid),
  );
  const watchedArtists = new Set(
    (db.prepare('SELECT mbid FROM artists WHERE mbid IS NOT NULL AND present = 1').all() as {
      mbid: string;
    }[]).map((r) => r.mbid),
  );

  return rows.map((r) => {
    const key = r.kind === 'artist' ? null : r.id.replace(/^plex:\/\/(movie|show)\//, '');
    return {
      kind: r.kind as Suggestion['kind'],
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      year: r.year,
      score: Math.round(r.score),
      seeds: JSON.parse(r.seeds) as string[],
      link: r.link,
      thumb: r.thumb,
      overview: r.overview ?? '',
      rating_key: key && key !== r.id ? key : null,
      tracked: r.kind === 'artist' ? watchedArtists.has(r.id) : watchlisted.has(r.id),
    };
  });
}

export function hideSuggestion(kind: string, id: string, hidden: boolean): void {
  db.prepare('UPDATE suggestions SET hidden = ? WHERE kind = ? AND id = ?').run(
    hidden ? 1 : 0,
    kind,
    id,
  );
}

export async function buildSuggestions(
  what: 'all' | 'music' | 'video',
  onProgress?: (m: string) => void,
): Promise<SuggestionRun> {
  let music = 0;
  let video = 0;
  const problems: string[] = [];

  if (what === 'all' || what === 'music') {
    try {
      const rows = await buildMusicSuggestions(onProgress);
      save(rows, ['artist']);
      music = rows.length;
    } catch (err) {
      problems.push(`music: ${(err as Error).message}`);
    }
  }
  if (what === 'all' || what === 'video') {
    try {
      const films = await buildVideoSuggestions(onProgress);
      const shows = await buildShowSuggestions(onProgress);
      save([...films, ...shows], ['movie', 'show']);
      video = films.length + shows.length;
    } catch (err) {
      problems.push(`film and TV: ${(err as Error).message}`);
    }
  }

  return {
    music,
    video,
    generated_at: nowIso(),
    message: problems.length
      ? `Some suggestions could not be built (${problems.join('; ')}).`
      : `${music} artists and ${video} titles suggested.`,
  };
}
