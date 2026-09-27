/**
 * When an episode actually reaches Sydney.
 *
 * Plex Discover gives an episode one date, `originallyAvailableAt`, and it is a
 * bare calendar date in whatever country the show comes from. It carries no
 * time and no zone. Treating it as a Sydney date, which is what this app did,
 * is wrong by a day for anything that airs in the American evening: ABC at
 * 22:00 in New York on the 22nd is noon in Sydney on the 23rd.
 *
 * Nothing in the Plex payload can fix that. Its `addedAt` looks like a real
 * instant but decodes to midnight UTC of the same bare date, so it is derived
 * from the date rather than evidence about it.
 *
 * TVMaze publishes `airstamp`, a genuine instant with an offset, free and
 * without a key. Converting that to a Sydney calendar date is exact: it is
 * right for a broadcast in the American evening and equally right for a
 * streaming drop that Sydney gets the same afternoon. A blanket "add a day"
 * would get the second case wrong.
 */
import { sydneyDate } from './dates.ts';

/** How an episode's Sydney date was arrived at. */
export type AirSource =
  /** Converted from a real TVMaze instant. Exact. */
  | 'tvmaze'
  /** No instant to be had, so the origin date is held back a day. */
  | 'estimated'
  /** TVMaze could not be reached, so Plex's own date stands. */
  | 'plex';

export interface ResolvedAir {
  /** The Sydney calendar date, which is what the feed compares against. */
  air_date: string | null;
  /** The instant it came from, kept so a later refresh can show its working. */
  air_stamp: string | null;
  air_source: AirSource;
}

/** The calendar day after a YYYY-MM-DD date, through UTC so no zone shifts it. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

/**
 * The Sydney date an episode belongs to.
 *
 * `lookup` says what we know about the show, and the distinction matters. A
 * show TVMaze genuinely does not carry is held back a day, which is the
 * conservative reading and never announces something before it happens. A
 * lookup that merely failed is not evidence of anything: shifting on a dropped
 * connection would walk every date forward another day on each failed refresh.
 */
export function resolveAir(
  plexDate: string | null,
  airstamp: string | undefined | null,
  lookup: 'matched' | 'absent' | 'unknown',
): ResolvedAir {
  if (airstamp) {
    const at = new Date(airstamp);
    if (!Number.isNaN(at.getTime())) {
      return { air_date: sydneyDate(airstamp), air_stamp: airstamp, air_source: 'tvmaze' };
    }
  }
  if (!plexDate) return { air_date: null, air_stamp: null, air_source: 'plex' };
  if (lookup === 'unknown') {
    return { air_date: plexDate, air_stamp: null, air_source: 'plex' };
  }
  return { air_date: nextDay(plexDate), air_stamp: null, air_source: 'estimated' };
}

/* ------------------------------------------------------------- TVMaze */

const TVMAZE = 'https://api.tvmaze.com';

export interface TvmazeEpisode {
  season: number | null;
  number: number | null;
  airstamp: string | null;
}

/** An episode's place in a season, for matching Plex's numbering to TVMaze's. */
export function epKey(season: number | null, episode: number | null): string | null {
  if (typeof season !== 'number' || typeof episode !== 'number') return null;
  return `${season}|${episode}`;
}

/** Season and number to air stamp, for one show. Undated rows are no use. */
export function airstampIndex(eps: TvmazeEpisode[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const e of eps) {
    const key = epKey(e.season, e.number);
    if (key && e.airstamp) index.set(key, e.airstamp);
  }
  return index;
}

/**
 * TVDB is the id TVMaze matches most reliably for television, so it is tried
 * first. TMDB is not a lookup key there, so a show carrying only that one
 * cannot be found this way.
 */
export function tvmazeLookupUrl(ids: Record<string, string>): string | null {
  if (ids.tvdb) return `${TVMAZE}/lookup/shows?thetvdb=${encodeURIComponent(ids.tvdb)}`;
  if (ids.imdb) return `${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(ids.imdb)}`;
  return null;
}

/** Plex returns ids as `tvdb://383203`. Flattened to `{ tvdb: '383203' }`. */
export function parseGuids(guids: { id?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of guids ?? []) {
    const [scheme, value] = (g.id ?? '').split('://');
    if (scheme && value) out[scheme] = value;
  }
  return out;
}

export interface ShowAirTimes {
  lookup: 'matched' | 'absent' | 'unknown';
  /** TVMaze's id for the show, worth remembering so the lookup is paid once. */
  tvmazeId: number | null;
  stamps: Map<string, string>;
}

const NONE: ShowAirTimes = { lookup: 'unknown', tvmazeId: null, stamps: new Map() };

async function getJson(url: string): Promise<unknown | 'absent'> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PlexMediaTracker ( local personal use )' },
    signal: AbortSignal.timeout(20_000),
  });
  // TVMaze answers a lookup it cannot satisfy with a 404, which is an answer,
  // not a failure. Anything else is a failure and must not be read as absence.
  if (res.status === 404) return 'absent';
  if (!res.ok) throw new Error(`TVMaze returned HTTP ${res.status}`);
  return await res.json();
}

/**
 * Air stamps for one show. `tvmazeId` skips the lookup when it is already
 * known, which is the usual case after the first refresh.
 */
export async function showAirTimes(
  ids: Record<string, string>,
  tvmazeId?: number | null,
): Promise<ShowAirTimes> {
  try {
    let id = tvmazeId ?? null;
    if (!id) {
      const url = tvmazeLookupUrl(ids);
      // No id TVMaze accepts is the same as TVMaze not carrying the show: the
      // answer will not arrive by asking again, so the estimate stands.
      if (!url) return { lookup: 'absent', tvmazeId: null, stamps: new Map() };
      const show = await getJson(url);
      if (show === 'absent') return { lookup: 'absent', tvmazeId: null, stamps: new Map() };
      const found = (show as { id?: number }).id;
      if (typeof found !== 'number') return { lookup: 'absent', tvmazeId: null, stamps: new Map() };
      id = found;
    }

    const eps = await getJson(`${TVMAZE}/shows/${id}/episodes?specials=1`);
    if (eps === 'absent') return { lookup: 'absent', tvmazeId: id, stamps: new Map() };
    return { lookup: 'matched', tvmazeId: id, stamps: airstampIndex(eps as TvmazeEpisode[]) };
  } catch {
    return NONE;
  }
}
