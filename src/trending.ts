/**
 * What is popular right now, as opposed to what is coming for things already
 * followed. Films and television come from TMDB weekly trending; country music
 * comes from the Apple iTunes RSS chart, which needs no API key.
 *
 * The design and the sources that were rejected are written up in
 * docs/specs/2026-09-19-trending-design.md.
 */

import { db, getSetting } from './db.ts';
import { nowIso } from './dates.ts';
import { normaliseArtistName, normaliseTitleForOwnership } from './matching.ts';
import { searchArtist } from './musicbrainz.ts';
import { trendingFromTmdb } from './tmdb.ts';
import { findDiscoverMatch } from './search.ts';

export type TrendingKind = 'movie' | 'show' | 'album' | 'single';

export interface ChartRow {
  kind: TrendingKind;
  id: string;
  rank: number;
  title: string;
  subtitle: string;
  release_date: string | null;
  thumb: string | null;
  link: string | null;
}

interface AppleEntry {
  'im:name'?: { label?: string };
  'im:artist'?: { label?: string };
  'im:image'?: { label?: string; attributes?: { height?: string } }[];
  'im:releaseDate'?: { label?: string };
  id?: { attributes?: { 'im:id'?: string } };
  link?: { attributes?: { href?: string } } | { attributes?: { href?: string } }[];
}

/** Apple links an album with one object and a song with an array of them. */
function firstHref(link: AppleEntry['link']): string | null {
  const one = Array.isArray(link) ? link[0] : link;
  return one?.attributes?.href ?? null;
}

/** Select the largest artwork by height, falling back to the last entry when heights are unavailable. */
function largestImage(images: { label?: string; attributes?: { height?: string } }[]): string | null {
  if (images.length === 0) return null;
  let largest = images[0];
  let largestHeight = 0;

  for (const img of images) {
    const height = img.attributes?.height ? parseInt(img.attributes.height, 10) : 0;
    if (height > largestHeight) {
      largestHeight = height;
      largest = img;
    }
  }

  return largestHeight > 0 ? largest.label ?? null : images[images.length - 1]?.label ?? null;
}

export function parseAppleChart(raw: unknown, kind: 'album' | 'single'): ChartRow[] {
  const entries = (raw as { feed?: { entry?: AppleEntry[] } })?.feed?.entry;
  if (!Array.isArray(entries)) return [];

  const out: ChartRow[] = [];
  for (const e of entries) {
    // Guard against null or non-object elements in the array.
    if (typeof e !== 'object' || e === null) continue;
    const title = e['im:name']?.label;
    if (!title) continue;
    const images = e['im:image'] ?? [];
    const artist = e['im:artist']?.label ?? '';
    out.push({
      kind,
      id: e.id?.attributes?.['im:id'] ?? `${title}|${artist}`,
      rank: out.length + 1,
      title,
      subtitle: artist,
      release_date: e['im:releaseDate']?.label?.slice(0, 10) ?? null,
      thumb: largestImage(images),
      link: firstHref(e.link),
    });
  }
  return out;
}

/* ------------------------------------------------------- artist resolution */

const ARTIST_CACHE = `
CREATE TABLE IF NOT EXISTS artist_mbid_cache (
  name_folded TEXT PRIMARY KEY,
  mbid        TEXT,
  looked_up   TEXT NOT NULL
);`;
db.exec(ARTIST_CACHE);

/** Matching the YouTube cache, for the same reason: answers barely move. */
const ARTIST_CACHE_DAYS = 14;

/** MusicBrainz scores below this are guesses, and a guess here mistracks. */
const MIN_ARTIST_SCORE = 70;

/**
 * The chart gives a name and nothing else, so the name has to be exact once
 * folded. Watching the wrong artist is silent and hard to notice, so refusing
 * is better than guessing.
 */
export function pickArtistMatch(
  candidates: { id: string; name: string; score: number }[],
  wanted: string,
): string | null {
  const want = normaliseArtistName(wanted);
  for (const c of candidates) {
    if (c.score >= MIN_ARTIST_SCORE && normaliseArtistName(c.name) === want) return c.id;
  }
  return null;
}

/**
 * MusicBrainz allows one request per second, so the chart's hundred rows would
 * be a hundred seconds. The chart repeats artists heavily and the answer is
 * cached by folded name, so in practice a rebuild costs seconds.
 */
export async function resolveArtist(name: string): Promise<string | null> {
  const folded = normaliseArtistName(name);
  if (!folded) return null;

  const row = db
    .prepare('SELECT mbid, looked_up FROM artist_mbid_cache WHERE name_folded = ?')
    .get(folded) as { mbid: string | null; looked_up: string } | undefined;
  if (row && Date.now() - Date.parse(row.looked_up) < ARTIST_CACHE_DAYS * 86_400_000) {
    return row.mbid;
  }

  let candidates;
  try {
    candidates = await searchArtist(name);
  } catch {
    // MusicBrainz was not actually asked, so there is no answer to remember.
    // Caching null here would misrepresent an outage as "no such artist" and
    // hide the button for a fortnight; leaving the row alone means the next
    // build simply asks again.
    return null;
  }

  // A real answer, found or not, is worth the fortnight of caching.
  const mbid = pickArtistMatch(candidates, name);
  db.prepare(
    `INSERT INTO artist_mbid_cache (name_folded, mbid, looked_up) VALUES (?, ?, ?)
     ON CONFLICT(name_folded) DO UPDATE SET mbid = excluded.mbid, looked_up = excluded.looked_up`,
  ).run(folded, mbid, nowIso());
  return mbid;
}

/* ------------------------------------------------------- album ownership */

export interface LibraryArtist {
  plexKey: string;
  // Original, unnormalised album titles, not plex_albums.norm_title. That
  // column was produced by normaliseTitle, which strips every bracket
  // unconditionally, so "Chief (Live)" is already just "chief" in it and the
  // "(Live)" is gone beyond recovery. Ownership needs the stricter, bracket-
  // aware normaliseTitleForOwnership instead, which can only be applied here,
  // on the raw title, not after the old normalisation has already thrown the
  // distinguishing word away.
  albumTitles: Set<string>;
}

/**
 * A chart album or single is in the library when its resolved artist is a
 * real Plex artist, not a manually watched one, and that artist has an album
 * whose normalised title matches the chart title's. This is deliberately
 * album-level rather than artist-level: see the "Already have it" section of
 * docs/specs/2026-09-19-trending-design.md for why the spec's literal wording
 * was not followed.
 *
 * `artist` is null both when the chart row has no resolved mbid and when the
 * mbid does not belong to any tracked artist, so a null mbid needs no
 * separate check here.
 */
export function albumInLibrary(chartTitle: string, artist: LibraryArtist | null): boolean {
  if (!artist) return false;
  // Checked explicitly rather than relying on manual artists being absent
  // from plex_albums, so this stays correct even if a caller's query ever
  // stops filtering manual artists out itself.
  if (artist.plexKey.startsWith('manual:')) return false;
  const want = normaliseTitleForOwnership(chartTitle);
  for (const title of artist.albumTitles) {
    if (normaliseTitleForOwnership(title) === want) return true;
  }
  return false;
}

/* --------------------------------------------------------------- Apple */

/** Genre 6 is Country. The US chart leads the Australian one. */
const APPLE_CHART = (what: string) =>
  `https://itunes.apple.com/us/rss/${what}/limit=50/genre=6/json`;

export async function trendingFromApple(kind: 'album' | 'single'): Promise<ChartRow[]> {
  const res = await fetch(APPLE_CHART(kind === 'album' ? 'topalbums' : 'topsongs'), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Apple returned HTTP ${res.status}`);
  return parseAppleChart(await res.json(), kind);
}

/* ------------------------------------------------------------- storage */

export interface TrendingRow extends ChartRow {
  rating_key: string | null;
  guid: string | null;
  mbid: string | null;
  tracked: boolean;
  in_library: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trending_items (
  kind         TEXT NOT NULL,
  id           TEXT NOT NULL,
  rank         INTEGER NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT NOT NULL DEFAULT '',
  release_date TEXT,
  thumb        TEXT,
  link         TEXT,
  rating_key   TEXT,
  guid         TEXT,
  mbid         TEXT,
  built_at     TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS trending_hidden (
  kind      TEXT NOT NULL,
  id        TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);`;
db.exec(SCHEMA);

/**
 * Hiding lives in its own table because trending_items is emptied and rewritten
 * on every build, so a hidden column would be wiped with it.
 */
export function mergeHidden(rows: TrendingRow[], hidden: Set<string>): TrendingRow[] {
  return rows.filter((r) => !hidden.has(`${r.kind}:${r.id}`));
}

/**
 * Each kind is rewritten whole rather than diffed, since rank and artwork
 * change constantly and there is nothing worth preserving row by row. The
 * delete is scoped to `kinds` rather than the whole table: a source that
 * failed this run (TMDB down, say) contributes no rows and no kind, so its
 * previous chart is left standing instead of being wiped down to nothing.
 * INSERT OR REPLACE means a duplicate id within one build (TMDB has done
 * this before, upstream now dedupes) simply keeps the last row seen rather
 * than throwing the whole build away over one bad pair.
 */
export function saveTrending(rows: TrendingRow[], kinds: TrendingKind[]): void {
  const at = nowIso();
  db.exec('BEGIN');
  try {
    const del = db.prepare('DELETE FROM trending_items WHERE kind = ?');
    for (const kind of kinds) del.run(kind);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO trending_items
         (kind, id, rank, title, subtitle, release_date, thumb, link, rating_key, guid, mbid, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(
        r.kind, r.id, r.rank, r.title, r.subtitle, r.release_date,
        r.thumb, r.link, r.rating_key, r.guid, r.mbid, at,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * When each chart was last (re)built, one timestamp per kind rather than one
 * for the whole table. `saveTrending` only replaces the kinds that actually
 * rebuilt, so after a partial rebuild the table can hold a fresh film chart
 * next to a week-old show chart; a single MAX(built_at) across everything
 * would label the stale one as today, which is the exact failure this
 * feature must not have. A kind with no rows yet is simply absent.
 */
export function builtAt(): Record<TrendingKind, string | null> {
  const rows = db
    .prepare('SELECT kind, MAX(built_at) AS at FROM trending_items GROUP BY kind')
    .all() as { kind: TrendingKind; at: string }[];
  const out: Record<TrendingKind, string | null> = {
    movie: null,
    show: null,
    album: null,
    single: null,
  };
  for (const r of rows) out[r.kind] = r.at;
  return out;
}

export function hideTrending(kind: string, id: string, hidden: boolean): void {
  if (hidden) {
    db.prepare(
      'INSERT OR REPLACE INTO trending_hidden (kind, id, hidden_at) VALUES (?, ?, ?)',
    ).run(kind, id, nowIso());
  } else {
    db.prepare('DELETE FROM trending_hidden WHERE kind = ? AND id = ?').run(kind, id);
  }
}

export function listTrending(): TrendingRow[] {
  const raw = db
    .prepare('SELECT * FROM trending_items ORDER BY kind, rank')
    .all() as Record<string, unknown>[];

  const held = new Set(
    (db.prepare('SELECT guid FROM library_guids').all() as { guid: string }[]).map((r) => r.guid),
  );
  const watchlisted = new Set(
    (db.prepare("SELECT rating_key FROM watchlist_items WHERE state = 'listed'").all() as {
      rating_key: string;
    }[]).map((r) => r.rating_key),
  );
  const watchedArtists = new Set(
    (db.prepare('SELECT mbid FROM artists WHERE mbid IS NOT NULL AND present = 1').all() as {
      mbid: string;
    }[]).map((r) => r.mbid),
  );
  const hidden = new Set(
    (db.prepare('SELECT kind, id FROM trending_hidden').all() as {
      kind: string;
      id: string;
    }[]).map((r) => `${r.kind}:${r.id}`),
  );

  // Keyed by mbid so a chart row's own resolved mbid is a single map lookup.
  // Built from every artist that has an mbid, manual ones included, because
  // albumInLibrary needs to see a manual artist's plex_key to refuse it
  // rather than the row simply looking unresolved.
  const libraryArtists = new Map<string, LibraryArtist>();
  {
    const artistRows = db
      .prepare('SELECT plex_key, mbid FROM artists WHERE mbid IS NOT NULL')
      .all() as { plex_key: string; mbid: string }[];
    // The raw title, not norm_title: see the LibraryArtist comment above for
    // why ownership has to re-normalise from the original text itself.
    const albumRows = db
      .prepare('SELECT artist_key, title FROM plex_albums')
      .all() as { artist_key: string; title: string }[];
    const albumsByArtistKey = new Map<string, Set<string>>();
    for (const a of albumRows) {
      let set = albumsByArtistKey.get(a.artist_key);
      if (!set) {
        set = new Set();
        albumsByArtistKey.set(a.artist_key, set);
      }
      set.add(a.title);
    }
    for (const ar of artistRows) {
      libraryArtists.set(ar.mbid, {
        plexKey: ar.plex_key,
        albumTitles: albumsByArtistKey.get(ar.plex_key) ?? new Set(),
      });
    }
  }

  const rows = raw.map((r) => ({
    kind: r.kind as TrendingKind,
    id: String(r.id),
    rank: Number(r.rank),
    title: String(r.title),
    subtitle: String(r.subtitle ?? ''),
    release_date: (r.release_date as string) ?? null,
    thumb: (r.thumb as string) ?? null,
    link: (r.link as string) ?? null,
    rating_key: (r.rating_key as string) ?? null,
    guid: (r.guid as string) ?? null,
    mbid: (r.mbid as string) ?? null,
    // Branch on kind rather than on which field happens to be set: films and
    // shows are tracked through the Plex watchlist, music through the artist
    // library, and these are two different mechanisms with nothing else in
    // common. Deciding by field presence would give today's right answer for
    // the wrong reason and go quietly wrong the day a row breaks that pattern.
    tracked:
      r.kind === 'movie' || r.kind === 'show'
        ? r.rating_key !== null && watchlisted.has(r.rating_key as string)
        : r.mbid !== null && watchedArtists.has(r.mbid as string),
    // Same branch-on-kind reasoning as tracked. Films and shows carry a Plex
    // GUID once resolved; music never does, because Apple's chart has no Plex
    // identifier at all. Music ownership is checked instead through the
    // resolved artist's own albums, at the album named by this exact row, not
    // the artist as a whole: see albumInLibrary for why that is deliberate.
    in_library:
      r.kind === 'movie' || r.kind === 'show'
        ? r.guid !== null && held.has(r.guid as string)
        : albumInLibrary(
            String(r.title),
            r.mbid !== null ? libraryArtists.get(r.mbid as string) ?? null : null,
          ),
  }));
  return mergeHidden(rows, hidden);
}

/* ----------------------------------------------------------------- build */

/**
 * Assembles all four charts into one table: TMDB films and shows, then Apple
 * country albums and singles. Each chart is fetched and resolved inside its
 * own try/catch so one failing service (TMDB down, Apple unreachable) cannot
 * empty the other charts; the failure is recorded in `notes` and reported in
 * the returned message instead.
 */
/** Joins labels the way a sentence would, not a comma-separated dump. */
function englishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export async function buildTrending(
  onProgress?: (m: string) => void,
): Promise<{ count: number; message: string }> {
  const key = getSetting('tmdb_api_key').trim();
  const token = getSetting('plex_token');
  const notes: string[] = [];
  const rows: TrendingRow[] = [];
  // Only a kind that actually rebuilt this run gets deleted and replaced, so
  // a source that failed leaves the chart the user already had in place
  // rather than the whole table being wiped whenever one of four
  // independent sources has a bad night.
  const succeeded: TrendingKind[] = [];
  // Human-readable names of charts that did not refresh this run, for the
  // message below, so a stale film chart is never mistaken for a current one.
  const stale: string[] = [];

  // Films and shows. Without a TMDB key these two lists are simply absent, and
  // the tab says so rather than showing an empty chip.
  if (key) {
    for (const kind of ['movie', 'show'] as const) {
      onProgress?.(`Trending ${kind === 'movie' ? 'films' : 'shows'}`);
      // Built locally rather than pushed straight into `rows`: `discoverSearch`
      // (inside findDiscoverMatch) can throw partway through this loop, and a
      // partial row set must never reach `rows` on its own, since `rows` and
      // `succeeded` are merged together below and have to stay in lockstep.
      const built: TrendingRow[] = [];
      try {
        const chart = await trendingFromTmdb(kind, key);
        for (let i = 0; i < chart.length; i += 1) {
          const row = chart[i]!;
          onProgress?.(`Matching ${kind} ${i + 1} of ${chart.length}: ${row.title}`);
          const year = row.release_date ? Number(row.release_date.slice(0, 4)) : null;
          // Kind is passed through so a trending film can never resolve to a
          // show of the same name, or vice versa.
          //
          // This lookup gets its own try/catch, separate from the chart-level
          // one below. discoverSearch throws on any non-ok Plex response, and
          // without this, one bad reply to one row would abort the entire
          // TMDB chart, while having no Plex token at all builds the chart
          // fine with no Add buttons. Those are the same user-facing outcome
          // (Plex can't be asked) and must degrade the same way: this row is
          // simply left unresolved, matching the spec's rule that a row whose
          // artist (or, here, title) cannot be resolved still appears.
          let match: { ratingKey: string; guid: string } | null = null;
          if (token) {
            try {
              match = await findDiscoverMatch(row.title, year, token, kind);
            } catch {
              match = null;
            }
          }
          built.push({
            ...row,
            rating_key: match?.ratingKey ?? null,
            guid: match?.guid ?? null,
            mbid: null,
            tracked: false,
            in_library: false,
          });
        }
        // The only point where a chart's rows and its kind become visible to
        // saveTrending, and they move together: a throw above skips both, so
        // this kind's old rows are neither deleted nor overwritten by a
        // fragment of the new chart.
        rows.push(...built);
        succeeded.push(kind);
      } catch (err) {
        // trendingFromTmdb throws on any failed page rather than returning a
        // short chart, so catching here is the only error handling this
        // chart needs: the failure is noted and the other three charts still
        // build.
        notes.push(`${kind}: ${(err as Error).message}`);
        stale.push(kind === 'movie' ? 'films' : 'shows');
      }
    }
  } else {
    notes.push('no TMDB key, so films and shows were skipped');
    stale.push('films', 'shows');
  }

  // Country music. No key needed.
  for (const kind of ['album', 'single'] as const) {
    onProgress?.(`Trending country ${kind}s`);
    // Same reasoning as the film and show loop above: build locally and only
    // merge into `rows` once the whole chart has resolved, so `rows` and
    // `succeeded` cannot drift apart if resolveArtist or the fetch throws.
    const built: TrendingRow[] = [];
    try {
      const chart = await trendingFromApple(kind);
      for (let i = 0; i < chart.length; i += 1) {
        const row = chart[i]!;
        // Named per artist rather than just a counter: MusicBrainz allows one
        // lookup a second, so a full chart of uncached artists is over a
        // minute of otherwise silent waiting.
        onProgress?.(`Matching artist ${i + 1} of ${chart.length}: ${row.subtitle}`);
        built.push({
          ...row,
          rating_key: null,
          guid: null,
          mbid: await resolveArtist(row.subtitle),
          tracked: false,
          in_library: false,
        });
      }
      rows.push(...built);
      succeeded.push(kind);
    } catch (err) {
      notes.push(`country ${kind}s: ${(err as Error).message}`);
      stale.push(kind === 'album' ? 'country albums' : 'country singles');
    }
  }

  saveTrending(rows, succeeded);

  // Counted from the table rather than `rows.length`, since a partial
  // failure leaves a preserved chart's rows sitting in the table without
  // them ever having passed through `rows` this run; the count must match
  // what the tab is about to show, not just what was fetched.
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM trending_items').get() as { n: number }
  ).n;
  const message = stale.length
    ? `${count} trending items. ${englishList(stale)} did not refresh and ` +
      `${stale.length > 1 ? 'are' : 'is'} showing the previous chart (${notes.join('; ')}).`
    : `${count} trending items.`;
  return { count, message };
}
