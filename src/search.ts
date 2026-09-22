/**
 * Searching the outside world from inside the app, so a film, show or artist
 * can be found and tracked without leaving the dashboard.
 *
 * Films and shows come from Plex Discover, the same source the watchlist uses,
 * so adding one is a direct call with no identity matching. Artists come from
 * MusicBrainz.
 */
import * as store from './db.ts';
import { db } from './db.ts';
import { searchArtist } from './musicbrainz.ts';
import { addToWatchlist } from './plexdiscover.ts';
import { APP_NAME } from './config.ts';
import { nowIso } from './dates.ts';

const DISCOVER = 'https://discover.provider.plex.tv';

export interface SearchHit {
  kind: 'movie' | 'show' | 'artist';
  id: string;
  title: string;
  subtitle: string;
  year: number | null;
  thumb: string | null;
  /** Already on the watchlist, or already a tracked artist. */
  tracked: boolean;
  /** Already sitting on the Plex server. */
  in_library: boolean;
}

interface RawHit {
  ratingKey?: string;
  guid?: string;
  title?: string;
  year?: number;
  type?: string;
  thumb?: string;
}

/* ------------------------------------------------------------ films and TV */

/**
 * Folds a title so case and punctuation stop mattering. `normaliseTitle` in
 * matching.ts is deliberately loose for the same reason album re-releases are
 * loose: it drops leading articles and edition noise so "The Album (Deluxe)"
 * lines up with "Album". That is wrong here. A chart row is resolved to a
 * single Discover key that gets written straight to the watchlist, so folding
 * away "The" or "A" risks matching the wrong film (for example "A Star" would
 * collide with "Star"). This fold only removes case and punctuation.
 */
function foldTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How well a Discover result answers a chart row. The title has to be exact
 * once folded, because a near miss here puts the wrong film on the watchlist.
 * Kind (movie or show) must match exactly, checked before anything else, so a
 * trending film can never resolve to a show of the same name or vice versa.
 * Years are allowed to differ by one, since TMDB and Plex disagree about
 * films released either side of New Year.
 *
 * This still cannot fully distinguish two unrelated works of the same kind
 * that share a title and were released about a year apart (an old horror
 * film and a newer family film both called "Jack Frost", say). An exact year
 * match outranks a near one, so the right work wins whenever it is present in
 * the results at all. Verifying against a TMDB or IMDb id would close that
 * gap, but at the cost of one extra network call per chart row, roughly
 * doubling build time, to prevent a rare mistake the user can see and undo
 * with one click. That trade is not taken here; the residual risk is
 * accepted.
 */
export function scoreDiscoverMatch(
  hit: { title: string; year: number | null; kind: 'movie' | 'show' },
  want: { title: string; year: number | null; kind: 'movie' | 'show' },
): number {
  if (hit.kind !== want.kind) return 0;
  if (foldTitle(hit.title) !== foldTitle(want.title)) return 0;
  if (hit.year === null || want.year === null) return 5;
  const gap = Math.abs(hit.year - want.year);
  if (gap === 0) return 10;
  if (gap === 1) return 7;
  return 0;
}

/** One title, resolved to the key the watchlist actually needs. */
export async function findDiscoverMatch(
  title: string,
  year: number | null,
  token: string,
  kind: 'movie' | 'show',
): Promise<{ ratingKey: string; guid: string } | null> {
  // discoverSearch only ever yields 'movie' or 'show' hits (it drops
  // anything else before returning), so the cast below is safe; SearchHit's
  // kind is widened to include 'artist' only because it is shared with the
  // MusicBrainz search path.
  const hits = await discoverSearch(title, token);
  let best: { ratingKey: string; guid: string; score: number } | null = null;
  for (const h of hits) {
    const score = scoreDiscoverMatch(
      { title: h.title, year: h.year, kind: h.kind as 'movie' | 'show' },
      { title, year, kind },
    );
    if (score > 0 && (!best || score > best.score)) {
      best = {
        ratingKey: h.id,
        guid: `plex://${kind}/${h.id}`,
        score,
      };
    }
  }
  return best ? { ratingKey: best.ratingKey, guid: best.guid } : null;
}

async function discoverSearch(query: string, token: string): Promise<SearchHit[]> {
  const url =
    `${DISCOVER}/library/search?query=${encodeURIComponent(query)}` +
    `&searchTypes=movies,tv&searchProviders=discover&limit=12&includeMetadata=1`;

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': token,
      'X-Plex-Product': APP_NAME,
      'X-Plex-Client-Identifier': 'plex-media-tracker',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`plex.tv returned HTTP ${res.status}`);

  const data = (await res.json()) as {
    MediaContainer?: { SearchResults?: { SearchResult?: { Metadata?: RawHit }[] }[] };
  };

  const onWatchlist = new Set(
    (db.prepare("SELECT rating_key FROM watchlist_items WHERE state = 'listed'").all() as {
      rating_key: string;
    }[]).map((r) => r.rating_key),
  );
  const held = new Set(
    (db.prepare('SELECT guid FROM library_guids').all() as { guid: string }[]).map((r) => r.guid),
  );

  const out: SearchHit[] = [];
  const seen = new Set<string>();

  for (const group of data.MediaContainer?.SearchResults ?? []) {
    for (const entry of group.SearchResult ?? []) {
      const m = entry.Metadata;
      if (!m?.ratingKey || !m.title) continue;
      if (m.type !== 'movie' && m.type !== 'show') continue;
      if (seen.has(m.ratingKey)) continue;
      seen.add(m.ratingKey);

      out.push({
        kind: m.type,
        id: String(m.ratingKey),
        title: m.title,
        subtitle: m.type === 'movie' ? 'Film' : 'Show',
        year: typeof m.year === 'number' ? m.year : null,
        thumb: m.thumb ?? null,
        tracked: onWatchlist.has(String(m.ratingKey)),
        in_library: held.has(m.guid ?? `plex://${m.type}/${m.ratingKey}`),
      });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- artists */

function artistSearch(query: string): Promise<SearchHit[]> {
  const trackedMbids = new Set(
    (db.prepare('SELECT mbid FROM artists WHERE mbid IS NOT NULL AND present = 1').all() as {
      mbid: string;
    }[]).map((r) => r.mbid),
  );
  const inPlex = new Set(
    (db
      .prepare("SELECT mbid FROM artists WHERE mbid IS NOT NULL AND plex_key NOT LIKE 'manual:%'")
      .all() as { mbid: string }[]).map((r) => r.mbid),
  );

  return searchArtist(query).then((candidates) =>
    candidates
      .filter((c) => c.score >= 70)
      .slice(0, 8)
      .map((c) => ({
        kind: 'artist' as const,
        id: c.id,
        title: c.name,
        subtitle: [c.disambiguation, c.area].filter(Boolean).join(' · ') || 'Artist',
        year: null,
        thumb: null,
        tracked: trackedMbids.has(c.id),
        in_library: inPlex.has(c.id),
      })),
  );
}

/* ------------------------------------------------------------------ search */

export interface SearchResponse {
  hits: SearchHit[];
  notes: string[];
}

export async function search(query: string, kinds: Set<string>): Promise<SearchResponse> {
  const q = query.trim();
  const response: SearchResponse = { hits: [], notes: [] };
  if (q.length < 2) return response;

  const token = store.getSetting('plex_token');
  const jobs: Promise<SearchHit[]>[] = [];

  if (token && (kinds.has('movie') || kinds.has('show'))) {
    jobs.push(
      discoverSearch(q, token).catch((err: Error) => {
        response.notes.push(`Film and TV search failed: ${err.message}`);
        return [];
      }),
    );
  }
  if (kinds.has('artist')) {
    jobs.push(
      artistSearch(q).catch((err: Error) => {
        response.notes.push(`Artist search failed: ${err.message}`);
        return [];
      }),
    );
  }

  for (const batch of await Promise.all(jobs)) response.hits.push(...batch);
  response.hits = response.hits.filter((h) => kinds.has(h.kind));
  return response;
}

/* ------------------------------------------------------------- adding them */

/** Adds a film or show to the real Plex watchlist. */
export async function addFilmOrShow(ratingKey: string): Promise<void> {
  const token = store.getSetting('plex_token');
  if (!token) throw new Error('No Plex token stored.');
  await addToWatchlist(token, ratingKey);
}

/**
 * Starts watching an artist that is not in the Plex music library. The row uses
 * a synthetic key so the rest of the app treats it like any other artist, but
 * nothing is ever claimed to be owned.
 */
export function trackArtist(mbid: string, name: string): void {
  const key = `manual:${mbid}`;
  const existing = db.prepare('SELECT plex_key FROM artists WHERE plex_key = ?').get(key);
  if (existing) {
    db.prepare("UPDATE artists SET present = 1, muted = 0 WHERE plex_key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO artists (plex_key, name, sort_name, thumb, mbid, mb_status, album_count, present)
     VALUES (?, ?, ?, NULL, ?, 'manual', 0, 1)`,
  ).run(key, name, name, mbid);
}

export function untrackArtist(mbid: string): void {
  db.prepare("DELETE FROM artists WHERE plex_key = ? AND plex_key LIKE 'manual:%'").run(
    `manual:${mbid}`,
  );
  db.prepare('DELETE FROM releases WHERE plex_key = ?').run(`manual:${mbid}`);
}

const METADATA_HOST = 'https://metadata.provider.plex.tv';
const SEARCH_THUMB_HOST = 'metadata.provider.plex.tv';

/**
 * True only for plex.tv's own metadata host, the one place a Discover thumb
 * may legitimately point once it is an absolute URL rather than a path.
 */
export function isSearchThumbHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.port === '' && parsed.hostname === SEARCH_THUMB_HOST;
  } catch {
    return false;
  }
}

/**
 * `t` arrives on `/thumb` straight from the page's query string, so however
 * it is normally populated, nothing stops a request supplying any string
 * here. A thumb from Discover is meant to be a path relative to plex.tv's
 * metadata service, and that is the only place this may resolve to. A value
 * starting with "//" looks like such a path but is protocol-relative, and
 * would swap in whatever host follows it, so it is checked as an absolute
 * URL rather than treated as one.
 */
export function resolveSearchThumb(thumb: string): string | null {
  if (thumb.startsWith('/') && !thumb.startsWith('//')) {
    return `${METADATA_HOST}${thumb}`;
  }
  return isSearchThumbHost(thumb) ? thumb : null;
}

/** Proxy target for a Discover poster found through search. */
export function searchThumbUrl(thumb: string): string | null {
  const token = store.getSetting('plex_token');
  if (!token || !thumb) return null;
  // The token must never be appended to a URL that has not already cleared
  // the host check, so resolution happens first and the token goes on last.
  const target = resolveSearchThumb(thumb);
  if (!target) return null;
  return `${target}${target.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}`;
}

/** Records that a manual artist was added, for the scan log. */
export function noteManualAdd(): string {
  return nowIso();
}
